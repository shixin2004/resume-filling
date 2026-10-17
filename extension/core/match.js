/**
 * L2 启发式匹配引擎（DESIGN.md 6.3）。
 *
 * 刻意做成不碰 DOM 的纯函数：输入是扫描结果 + 词典 + 档案，输出是配对结果。
 * 这样可以在 Node 里直接跑单测（tools/selftest.mjs），不用起浏览器。
 */

(function () {
  const RFA = globalThis.__RFA;
  const N = RFA.N;

  /**
   * 上下文来源的可信度权重。
   * 只有「非精确命中」才乘权重——精确相等在任何来源上都是强信号。
   */
  const SOURCE_WEIGHT = {
    "label-for": 1.0,
    "aria-label": 1.0,
    "aria-labelledby": 1.0,
    "form-item-label": 1.0,
    "label-wrap": 0.95,
    "table-cell": 0.95,
    "form-item": 0.92,
    placeholder: 0.88,
    "prev-sibling": 0.85,
    ancestor: 0.8,
    title: 0.8,
    name: 0.75,
    id: 0.7
  };

  const T_FILL = 85; // >= 85 直接填，标绿
  const T_REVIEW = 60; // 60~84 填入但标黄，提示人工确认
  const T_SENSITIVE = 100; // 敏感字段只接受精确命中

  /**
   * 纯拉丁别名太短时不允许子串匹配（"xx" 会匹配到一堆无关的 id/name）。
   * 中文别名两个字就已经很有区分度，可以放宽。
   */
  function canSubstring(alias) {
    if (/[\u4e00-\u9fa5]/.test(alias)) return alias.length >= 2;
    return alias.length >= 3;
  }

  /** 控件类型与档案字段类型是否兼容——不兼容直接淘汰，这是防错填的第一道闸 */
  function typeCompat(kind, fieldType) {
    switch (kind) {
      case "file":
        return fieldType === "file";
      case "select":
      case "combobox":
        return ["enum", "text", "number", "date", "dateYm", "tel", "email", "bool"].includes(fieldType);
      case "radio":
      case "checkbox":
        return fieldType === "enum" || fieldType === "bool";
      case "date":
        return fieldType === "date" || fieldType === "dateYm";
      case "number":
        return ["number", "tel", "text", "date", "dateYm"].includes(fieldType);
      case "email":
        return fieldType === "email" || fieldType === "text";
      case "tel":
        return ["tel", "text", "number"].includes(fieldType);
      case "url":
        return fieldType === "url" || fieldType === "text";
      case "textarea":
        return fieldType === "textarea" || fieldType === "text" || fieldType === "array";
      case "text":
        return ["text", "number", "date", "dateYm", "tel", "email", "url", "enum", "array"].includes(fieldType);
      default:
        return false;
    }
  }

  /**
   * 单个候选控件对单个档案字段打分，返回 { score, src, weight }。
   *
   * weight 是胜出来源的权重，只在**同分时**当裁决用：
   * 页面里 `id="position"` 这类通用属性会命中英文别名拿到 100 分，
   * 而真正的字段标签「期望职位」也是 100 分 —— 不裁决就会按字段顺序随机取胜，
   * 实测表现为「期望职位被填成了实习职位」。裁决原则：标签 > id/name。
   */
  function scoreCandidate(cand, field) {
    const targets = [N.normalize(field.label)].concat(field.alias || []).filter(Boolean);
    let best = 0;
    let bestSrc = null;
    let bestWeight = 0;

    for (const c of cand.ctx) {
      if (!c.norm) continue;
      const weight = SOURCE_WEIGHT[c.src] == null ? 1 : SOURCE_WEIGHT[c.src];

      for (const t of targets) {
        let s = 0;

        if (c.norm === t) {
          s = 100; // 精确相等：不打折
        } else if (canSubstring(t) && c.norm.includes(t)) {
          s = 82 * weight;
        } else if (canSubstring(c.norm) && t.includes(c.norm)) {
          s = 78 * weight;
        } else if (c.norm.length >= 3 && t.length >= 3) {
          const sim = N.similarity(c.norm, t);
          if (sim >= 0.75) s = (60 + (sim - 0.75) * 100) * weight;
        }

        if (s > 0 && (s > best || (s === best && weight > bestWeight))) {
          best = s;
          bestSrc = c;
          bestWeight = weight;
        }
      }
    }

    return { score: Math.round(best), src: bestSrc, weight: bestWeight };
  }

  /**
   * 页面选项文本与档案值是否算同一个东西。
   * 三层：归一化相等 → 人工/LLM 生成的值归一映射 → 中文包含关系。
   */
  function optionMatchesValue(optionText, value, field, dict) {
    const o = N.normalize(optionText);
    const v = N.normalize(value);
    if (!o || !v) return false;
    if (o === v) return true;

    const map = dict.valueNormalization && dict.valueNormalization.examples;
    const fieldMap = map && map[field.key];
    if (fieldMap) {
      for (const [canonical, alts] of Object.entries(fieldMap)) {
        const group = [canonical].concat(alts || []).map(N.normalize);
        if (group.includes(v) && group.includes(o)) return true;
      }
    }

    // 中文选项常带前缀（"广东深圳" vs "深圳"）
    if (/[\u4e00-\u9fa5]/.test(v) && v.length >= 2 && o.includes(v)) return true;
    return false;
  }

  /**
   * 主入口。
   * @param {Array} candidates scan() 的结果
   * @param {Object} dict RFA.dict.load() 的结果
   * @param {Object} profile 简历档案
   * @returns {{pairs: Array, unmatched: Array, ignored: Array}}
   */
  function matchAll(candidates, dict, profile, opts = {}) {
    const scored = [];
    // 段作用域填充会用到这两个参数：只在一组字段里找，且取档案的第 arrayIndex 段
    const fields = opts.fields || dict.fields;
    const arrayIndex = opts.arrayIndex || 0;

    for (const cand of candidates) {
      if (cand.kind === "file") continue; // 文件上传单独处理（M2）

      for (const field of fields) {
        if (field.type === "file") continue;
        if (!typeCompat(cand.kind, field.type)) continue;

        const value = RFA.profile.formatForInput(
          RFA.profile.getValue(profile, field.key, arrayIndex) || ""
        );
        if (!value) continue; // 档案里没填的字段不猜

        const { score, src, weight } = scoreCandidate(cand, field);
        if (score <= 0) continue;

        // 敏感字段只接受精确命中（DESIGN.md 6.3）
        if (field.sensitive && score < T_SENSITIVE) continue;

        // 单选/复选：候选自身的选项文本必须与档案值一致才有意义
        if (cand.kind === "radio" || cand.kind === "checkbox") {
          if (!optionMatchesValue(cand.ownLabel, value, field, dict)) continue;
          if (score < T_REVIEW) continue;
        }

        scored.push({ cand, field, score, src, weight, value });
      }
    }

    const pairs = resolveConflicts(scored, candidates, dict);

    const matchedIdx = new Set(pairs.map((p) => p.cand.idx));
    // 单选/复选所在分组只要有配对成功，同组其它候选算「已忽略」而不是「未识别」，
    // 否则会出现「性别」下面「女」被标红这种荒谬提示。
    const matchedRadioGroups = new Set(
      pairs
        .filter((p) => p.cand.kind === "radio" || p.cand.kind === "checkbox")
        .map((p) => groupKey(p.cand))
    );

    const ignored = [];
    const unmatched = [];
    for (const cand of candidates) {
      if (matchedIdx.has(cand.idx)) continue;
      if ((cand.kind === "radio" || cand.kind === "checkbox") && matchedRadioGroups.has(groupKey(cand))) {
        ignored.push(cand);
      } else {
        unmatched.push(cand);
      }
    }

    return { pairs, unmatched, ignored };
  }

  /** 单选/复选的分组标识：优先 name 属性，其次用父节点的层级索引路径 */
  function groupKey(cand) {
    const el = cand.el;
    const name = el && el.getAttribute && el.getAttribute("name");
    if (name) return `name:${name}`;
    if (!el || !el.parentElement) return `idx:${cand.idx}`;

    const path = [];
    let node = el;
    for (let depth = 0; node && node.parentElement && depth < 4; depth++) {
      path.push(Array.from(node.parentElement.children).indexOf(node));
      node = node.parentElement;
    }
    return `path:${path.join(".")}`;
  }

  /**
   * 同分裁决：谁的匹配更可信。
   *   分数 → 胜出来源的权重（标签 > name > id） → 用户自定义字段。
   *
   * 加最后一条是因为自定义字段是用户「自己教的」：他之所以去设置页加一列，
   * 往往就是因为内置字段在这类站点上盖不住。所以同分时让它赢，
   * 但**不额外加分** —— 内置字段的精确命中（100）依旧压过自定义字段的模糊命中（9x），
   * 免得用户随手加的别名把所有网站的内置字段都劫持走。
   */
  function better(a, b) {
    if (a.score !== b.score) return a.score - b.score;
    const w = (a.weight || 0) - (b.weight || 0);
    if (w) return w;
    return (a.field.custom ? 1 : 0) - (b.field.custom ? 1 : 0);
  }

  /** 冲突消解：每个档案字段最多占 maxOccurrence 个控件；每个控件只保留一个字段 */
  function resolveConflicts(scored, candidates, dict) {
    const byField = new Map();
    for (const s of scored) {
      const arr = byField.get(s.field.key) || [];
      arr.push(s);
      byField.set(s.field.key, arr);
    }

    const keep = new Set();
    for (const [key, arr] of byField) {
      const field = dict.byKey[key];
      // 同分时来源更可信的排前面（标签 > name > id），避免靠字段顺序决胜负
      arr.sort((a, b) => better(b, a));

      // 单选/复选不做数量上限：需要靠它们各自的选项文本决定勾哪一个
      const isChoice = arr[0].cand.kind === "radio" || arr[0].cand.kind === "checkbox";
      const limit = isChoice ? arr.length : field.maxOccurrence || 1;
      arr.slice(0, limit).forEach((s) => keep.add(s));
    }

    const bestPerCand = new Map();
    for (const s of scored) {
      if (!keep.has(s)) continue;
      const cur = bestPerCand.get(s.cand.idx);
      if (!cur || better(s, cur) > 0) bestPerCand.set(s.cand.idx, s);
    }

    return Array.from(bestPerCand.values()).sort((a, b) => a.cand.idx - b.cand.idx);
  }

  /** 分数 → 展示等级 */
  function levelOf(score) {
    if (score >= T_FILL) return "ok";
    if (score >= T_REVIEW) return "review";
    return "low";
  }

  RFA.match = {
    matchAll,
    scoreCandidate,
    typeCompat,
    optionMatchesValue,
    levelOf,
    canSubstring,
    SOURCE_WEIGHT,
    T_FILL,
    T_REVIEW,
    T_SENSITIVE
  };
})();
