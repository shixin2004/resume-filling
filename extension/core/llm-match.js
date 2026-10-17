/**
 * L3：把「规则匹配没能认出来的字段」交给大模型给出对应关系（DESIGN.md 6.5）。
 *
 * 这个文件是**纯逻辑** —— 输入是扫描结果 + 词典 + 档案 + 上游的匹配结果，
 * 输出是「要发出去的请求」和「从回答里解析出来的映射」，全程不碰 DOM、不发网络。
 * 所以 tools/selftest.mjs 能直接覆盖这几处最容易出事的地方：
 *   - 敏感字段与真实值绝不出现在请求里；
 *   - 模型给的 key 必须命中白名单；
 *   - 模型给的选项必须在页面上真的存在；
 *   - 输出不是 JSON 就当作失败，不猜不修补。
 *
 * 真正发请求的是 core/llm.js，编排在 content/content.js。
 */
(function () {
  const RFA = globalThis.__RFA;
  const N = RFA.N;

  const T_CONFIDENCE = 0.7; // 低于此值直接丢弃
  const MAX_FIELDS = 40; // 一次最多问这么多控件（多了模型也会糊）
  const MAX_KEYS = 80; // 字段清单上限
  const MAX_OPTIONS = 30; // 单个控件最多带多少个选项

  const CHOICE_KINDS = ["select", "combobox", "radio", "checkbox"];

  const SYSTEM_PROMPT = [
    "你是一个网页表单字段映射助手。用户会给你两份清单：",
    "  fields       —— 网页上还没被规则识别出来的可填控件（带标签、控件类型、必填、下拉选项）",
    "  profile_keys —— 求职者档案里**确实有内容**的字段（带 key、中文名、类型、取值范围）",
    "你的任务：判断每一个控件应该对应 profile_keys 里的哪一个字段。",
    "",
    "必须遵守：",
    "1. 只输出 JSON，不要输出任何解释、前言或 Markdown 代码块以外的文字。",
    "2. profile_key 只能取 profile_keys 里出现过的值，绝对不要发明新的 key。",
    "3. 没有把握就不要输出这一条。宁可漏掉，也不要猜 —— 填错比不填严重得多。",
    "4. confidence 是你对这条映射的把握（0~1）。低于 0.7 的结果会被丢弃。",
    "5. 如果控件是下拉/单选（kind 为 select / combobox / radio / checkbox），并且你有把握选中某个值，",
    "   请在 option 里给出**该控件 options 数组里出现过的原文**；拿不准就省略 option。",
    "6. 同一个标签可能出现在不同区块里（例如「工作经历」和「实习经历」的字段名完全一样），",
    "   此时以 label 里带的区块标题为准。",
    "7. 不要输出任何用户个人的真实信息，你不需要它们，也拿不到。",
    "",
    '输出格式：{"mappings":[{"idx":7,"profile_key":"contact.mobile","confidence":0.95},',
    '{"idx":9,"profile_key":"educations[].degree","option":"学士","confidence":0.9}]}',
    "没有可映射的控件就输出 {\"mappings\":[]}。"
  ].join("\n");

  const USER_HEADER = "fields 是页面上未识别的控件，profile_keys 是可用字段。请输出映射结果：";

  /* ---------- 决定要问谁 ---------- */

  /** 有可读标签的才值得问；连标签都没有的控件模型也无从下手，只会浪费 token */
  function hasLabel(cand) {
    return (cand.ctx || []).some((c) => c.norm && c.norm.length >= 2);
  }

  function defaultLabelOf(cand) {
    return (cand.ctx || [])
      .map((c) => String(c.text || "").trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" / ");
  }

  /**
   * 从全部候选里挑出「需要问模型」的那些：L2 没配上、不是文件、有标签。
   * 必填和有下拉选项的排在前面（它们的信息量最大），最后按页面顺序输出。
   */
  function pickTargets(candidates, dict, matched, opts = {}) {
    const paired = new Set(((matched && matched.pairs) || []).map((p) => p.cand.idx));
    const unmatched = new Set(((matched && matched.unmatched) || []).map((c) => c.idx));

    const pool = [];
    for (const cand of candidates) {
      if (cand.kind === "file") continue;
      if (paired.has(cand.idx) || !unmatched.has(cand.idx)) continue;
      if (!hasLabel(cand)) continue;
      pool.push(cand);
    }

    pool.sort(
      (a, b) =>
        (b.required ? 1 : 0) - (a.required ? 1 : 0) ||
        (b.options || []).length - (a.options || []).length ||
        a.idx - b.idx
    );

    const limit = opts.maxFields || MAX_FIELDS;
    return pool.slice(0, limit).sort((a, b) => a.idx - b.idx);
  }

  /* ---------- 字段清单（只发元信息，永远不发用户填的值） ---------- */

  /** 档案里这个字段真的有值吗（数组型看有没有任一段有值） */
  function profileHasValue(profile, field) {
    const p = RFA.profile.parseKey(field.key);
    if (p.isArray) {
      const list = profile && profile[p.array];
      if (!Array.isArray(list)) return false;
      return list.some((it) => it && String(it[p.field] == null ? "" : it[p.field]).trim() !== "");
    }
    const v = RFA.profile.getValue(profile, field.key, 0);
    return String(RFA.profile.formatForInput(v) || "").trim() !== "";
  }

  /**
   * 给模型看的「值长什么样」。
   *
   * 只能来自 schema 的 example（写死在词典里的假例子，如「张三」「13800000000」），
   * **绝不能读档案里的真实值** —— 用户的实际手机号、身份证号一个字都不许出去。
   */
  function sampleOf(field) {
    if (field.example) return field.example;
    switch (field.type) {
      case "dateYm":
        return "[YYYY-MM]";
      case "date":
        return "[YYYY-MM-DD]";
      case "tel":
        return "[11位数字]";
      case "email":
        return "[邮箱地址]";
      case "number":
        return "[数字]";
      case "textarea":
        return "[一段文字]";
      case "array":
        return "[多项，用分号分隔]";
      default:
        return "";
    }
  }

  function buildableKeys(dict, profile) {
    const out = [];
    for (const f of dict.fields) {
      if (f.sensitive) continue; // 敏感字段永不外发：硬约束，不参与任何可配置
      if (f.type === "file") continue;
      if (!profileHasValue(profile, f)) continue;
      const item = { key: f.key, label: f.label, type: f.type };
      if (f.enum) item.enum = f.enum;
      const sample = sampleOf(f);
      if (sample) item.sample = sample;
      out.push(item);
    }
    return out;
  }

  /* ---------- 组装请求 ---------- */

  /**
   * @param {Array} targets pickTargets 的结果
   * @param {Object} dict
   * @param {Object} profile
   * @param {Object} opts { labelOf } —— labelOf 让调用方把「所属区块标题」也拼进标签，
   *        这是同形字段（工作经历 vs 实习经历）唯一能分开的线索。
   * @returns {null|{messages: Array, ctx: Object, stats: Object}}
   */
  function buildRequest(targets, dict, profile, opts = {}) {
    const keys = buildableKeys(dict, profile).slice(0, opts.maxKeys || MAX_KEYS);
    if (!targets.length || !keys.length) return null;

    const labelOf = opts.labelOf || defaultLabelOf;
    const byIdx = {};
    const optionsByIdx = {};

    const fields = targets.map((cand) => {
      byIdx[cand.idx] = cand;
      const options = (cand.options || []).slice(0, MAX_OPTIONS);
      optionsByIdx[cand.idx] = options;

      const item = { idx: cand.idx, label: labelOf(cand), kind: cand.kind };
      if (cand.required) item.required = true;
      if (options.length) item.options = options;
      return item;
    });

    return {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${USER_HEADER}\n${JSON.stringify({ fields, profile_keys: keys })}` }
      ],
      ctx: { byIdx, optionsByIdx, allowedKeys: new Set(keys.map((k) => k.key)), targets, labelOf },
      stats: { fields: fields.length, keys: keys.length }
    };
  }

  /* ---------- 解析回答 ---------- */

  /** 模型爱把 JSON 包在 ```json 围栏里，或者前后加一句话。只做定位，不做修补。 */
  function extractJson(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return null;

    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1].trim() : s;

    try {
      return JSON.parse(body);
    } catch (_) {
      /* 继续尝试定位花括号块 */
    }
    const a = body.indexOf("{");
    const b = body.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(body.slice(a, b + 1));
      } catch (_) {
        /* 确实不是 JSON */
      }
    }
    return null;
  }

  /**
   * 回答 → 可信的映射。四道闸（DESIGN.md 6.5 的后处理）：
   * 置信度、白名单、选项真实性、每控件只留一条。
   * @returns {{mappings: Array, dropped: Array}}
   */
  function parseMappings(text, ctx) {
    const dropped = [];
    const parsed = extractJson(text);
    if (!parsed) return { mappings: [], dropped: [{ reason: "输出不是合法 JSON" }] };

    const list = Array.isArray(parsed.mappings) ? parsed.mappings : [];
    if (!Array.isArray(parsed.mappings)) dropped.push({ reason: "没有 mappings 数组" });

    const best = new Map();
    for (const raw of list) {
      if (!raw || typeof raw !== "object") {
        dropped.push({ reason: "条目不是对象", raw });
        continue;
      }

      const idx = Number(raw.idx);
      if (!Number.isFinite(idx) || !ctx.byIdx[idx]) {
        dropped.push({ reason: `idx 不在本次请求里：${raw.idx}`, raw });
        continue;
      }

      const key = String(raw.profile_key || "").trim();
      if (!ctx.allowedKeys.has(key)) {
        dropped.push({ reason: `字段不在白名单：${key || "(空)"}`, raw });
        continue;
      }

      const confidence = Number(raw.confidence);
      if (!Number.isFinite(confidence) || confidence < T_CONFIDENCE) {
        dropped.push({ reason: `置信度不足：${raw.confidence}`, raw });
        continue;
      }

      let option = raw.option == null ? "" : String(raw.option).trim();
      if (option) {
        const opts = ctx.optionsByIdx[idx] || [];
        const hit = opts.find((o) => N.normalize(o) === N.normalize(option));
        if (!hit) {
          dropped.push({ reason: `选项在页面上不存在：${option}`, raw });
          continue;
        }
        option = hit; // 用页面上的原文，避免差一个空格就选不中
      }

      const cur = best.get(idx);
      if (!cur || cur.confidence < confidence) best.set(idx, { idx, key, option, confidence });
    }

    return { mappings: [...best.values()].sort((a, b) => a.idx - b.idx), dropped };
  }

  /**
   * 映射 → 可以交给 fill.js 的配对。
   * 值取档案里对应那一段的（段号由调用方通过 arrayIndexOf 告诉这里），
   * 下拉/单选优先用模型指定的页面选项文本。
   */
  function toPairs(mappings, ctx, dict, profile, opts = {}) {
    const arrayIndexOf = opts.arrayIndexOf || (() => 0);
    const made = [];

    for (const m of mappings) {
      const cand = ctx.byIdx[m.idx];
      const field = dict.byKey[m.key];
      if (!cand || !field) continue;

      const arrayIndex = field.key.includes("[].") ? Number(arrayIndexOf(cand)) || 0 : 0;
      const useOption = CHOICE_KINDS.includes(cand.kind) && m.option;
      const value = useOption
        ? m.option
        : RFA.profile.formatForInput(RFA.profile.getValue(profile, field.key, arrayIndex));
      if (!value) continue;

      made.push({
        cand,
        field,
        value,
        arrayIndex,
        score: Math.round(m.confidence * 100),
        src: { src: "llm", text: "大模型推断" },
        source: "llm",
        confidence: m.confidence
      });
    }

    // 同一个字段不能被 L3 认领太多次（模型偶尔会把「姓名」和「曾用名」都映射到姓名）。
    // 组内（同段）按 maxOccurrence 裁，跨段的不同经历各算各的。
    made.sort((a, b) => b.score - a.score || a.cand.idx - b.cand.idx);
    const used = new Map();
    const kept = [];
    for (const p of made) {
      const scope = `${p.field.key}@${p.field.key.includes("[].") ? p.arrayIndex : "-"}`;
      const n = used.get(scope) || 0;
      if (n >= (p.field.maxOccurrence || 1)) continue;
      used.set(scope, n + 1);
      kept.push(p);
    }

    return kept.sort((a, b) => a.cand.idx - b.cand.idx);
  }

  /* ---------- 站点指纹（同一套结构不重复问） ---------- */

  function hash36(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /**
   * 对「要问的那批控件」算指纹：
   * 只要标签、类型、选项没变，页面的小改版（换皮肤、调顺序）不会让它失效。
   */
  function fingerprint(targets) {
    const parts = targets
      .map((c) =>
        [
          c.kind,
          (c.ctx || []).map((x) => x.norm).join("|"),
          (c.options || []).join("|")
        ].join("~")
      )
      .sort();
    return hash36(parts.join("~~"));
  }

  RFA.llmMatch = {
    pickTargets,
    buildRequest,
    parseMappings,
    toPairs,
    fingerprint,
    buildableKeys,
    sampleOf,
    profileHasValue,
    hasLabel,
    defaultLabelOf,
    extractJson,
    SYSTEM_PROMPT,
    T_CONFIDENCE,
    MAX_FIELDS,
    CHOICE_KINDS
  };
})();
