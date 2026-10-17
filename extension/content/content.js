/**
 * 内容脚本入口：编排 扫描 → 补齐多段经历 → 匹配 → L3 兜底 → 填充 → 汇总。
 *
 * 这个文件本身不做任何具体逻辑，只负责把 core/ 里的模块串起来，
 * 并响应 popup 的消息。
 *
 * 每一步的失败都被限制在它自己内部：多段经历点不出「添加」不影响其它字段填充，
 * 手动映射加载不出来也不会让整次填充失败，大模型连不上更只是少补几个字段。
 */
(function () {
  const RFA = globalThis.__RFA;

  let busy = false;
  let lastReport = null;
  let lastCandidates = [];
  let lastDict = null;
  let lastProfile = null;
  let lastGroups = [];

  function hostKey() {
    try {
      return location.host || "";
    } catch (_) {
      return "";
    }
  }

  /**
   * L1 站点适配器的结果覆盖 L2 的配对（人/精确规则 > 启发式打分）。
   * 目前适配器注册表是空的，M2 才会真正生效。
   */
  function applyAdapters(matched, candidates, dict, profile, adapter) {
    if (!adapter) return;
    const hits = RFA.adapters.apply(adapter, candidates);
    if (!hits.size) return;

    for (const [idx, key] of hits) {
      const cand = candidates.find((c) => c.idx === idx);
      const field = dict.byKey[key];
      if (!cand || !field) continue;

      const value = RFA.profile.formatForInput(RFA.profile.getValue(profile, key, 0));
      if (!value) continue;

      // 该控件与其它字段的既有配对要被顶掉，避免同一个控件被填两次
      matched.pairs = matched.pairs.filter((p) => p.cand.idx !== idx && p.field.key !== key);
      matched.unmatched = matched.unmatched.filter((c) => c.idx !== idx);
      matched.pairs.push({ cand, field, score: 100, src: { src: "adapter", text: adapter.id }, value });
    }
    matched.pairs.sort((a, b) => a.cand.idx - b.cand.idx);
  }

  /* ---------- L3：大模型补字段（可选；没配、失败、超时都只是少填几个字段） ---------- */

  /** 控件落在哪个区块里。把区块标题拼进标签，工作经历 / 实习经历那种同形字段才分得开 */
  function sectionTitleOf(cand, groups) {
    for (const g of groups || []) {
      for (const c of g.controls || []) {
        if (c.el === cand.el) return g.title || (g.section && g.section.label) || "";
      }
    }
    return "";
  }

  async function runL3(candidates, dict, profile, matched, segPlan) {
    const settings = await RFA.llm.getSettings();
    if (!settings.enabled || !RFA.llm.isReady(settings)) return { enabled: false, asked: 0, filled: 0 };

    const groups = (segPlan && segPlan.groups) || [];
    const targets = RFA.llmMatch.pickTargets(candidates, dict, matched);
    if (!targets.length) return { enabled: true, asked: 0, filled: 0 };

    const req = RFA.llmMatch.buildRequest(targets, dict, profile, {
      labelOf: (cand) => {
        const base = RFA.llmMatch.defaultLabelOf(cand);
        const sec = sectionTitleOf(cand, groups);
        if (!sec) return base;
        return base ? `${sec} › ${base}` : sec;
      }
    });
    if (!req) return { enabled: true, asked: 0, filled: 0 };

    // 同一站点、同一套字段结构在 TTL 内不重复问：云端便宜也是钱，而且模型每次给的答案会漂
    const cacheKey = `llmCache:${location.origin}#${RFA.llmMatch.fingerprint(targets)}`;
    let text = null;
    let cached = false;

    if (settings.cacheTtlMin > 0) {
      const bag = await chrome.storage.local.get(cacheKey);
      const hit = bag[cacheKey];
      if (hit && typeof hit.text === "string" && Date.now() - Number(hit.at || 0) < settings.cacheTtlMin * 60000) {
        text = hit.text;
        cached = true;
      }
    }

    if (text == null) {
      const res = await RFA.llm.chat(req.messages, { settings });
      if (!res.ok) return { enabled: true, asked: req.stats.fields, filled: 0, error: res.error };
      text = res.text;
      if (settings.cacheTtlMin > 0) {
        try {
          await chrome.storage.local.set({ [cacheKey]: { at: Date.now(), text } });
        } catch (_) {
          /* 缓存写不进去不影响本轮的填充 */
        }
      }
    }

    const parsed = RFA.llmMatch.parseMappings(text, req.ctx);
    const pairs = RFA.llmMatch.toPairs(parsed.mappings, req.ctx, dict, profile, {
      arrayIndexOf: (cand) => {
        const pos = RFA.repeatable.segmentIndexOf(cand.el, groups);
        return pos ? pos.index : 0;
      }
    });

    for (const p of pairs) {
      const pos = RFA.repeatable.segmentIndexOf(p.cand.el, groups);
      if (!pos) continue;
      const g = groups.find((x) => x.arrayKey === pos.arrayKey);
      p.segment = `${(g && g.section ? g.section.label : pos.arrayKey)} §${pos.index + 1}`;
      p.segmentIndex = pos.index;
    }

    const summary = {
      enabled: true,
      asked: req.stats.fields,
      filled: pairs.length,
      cached,
      dropped: parsed.dropped.length
    };
    if (!pairs.length) return summary;

    // L3 只处理「L2 没认出来」的控件；认领后必须从 unmatched 里摘掉，
    // 否则同一个控件会同时出现在报告的两栏里（手动映射踩过同样的坑）
    const claimed = new Set(pairs.map((p) => p.cand.idx));
    matched.unmatched = matched.unmatched.filter((c) => !claimed.has(c.idx));
    matched.pairs = matched.pairs.concat(pairs).sort((a, b) => a.cand.idx - b.cand.idx);

    return summary;
  }

  /** 组装给用户看的提示（多段与 L3 的说明放这里，而不是混进字段列表） */
  function buildNotes(seg, segPlan, l3) {
    const notes = [];

    if (seg.added) {
      notes.push(`已自动点击「添加」补齐 ${seg.added} 段经历。多段按档案顺序自上而下填入，请核对顺序。`);
    }
    for (const m of seg.missing || []) {
      notes.push(`${m.section}：档案里有 ${m.need} 段，页面上只有 ${m.have} 段（${m.reason}），请手动补齐后再点一次填充。`);
    }
    for (const g of (segPlan && segPlan.groups) || []) {
      if (g.filledBlocks > 1) notes.push(`${g.section.label}：已按段填入 ${g.filledBlocks} 段。`);
    }
    // 被区层判定为「另一类经历」的区块：必须明确告诉用户为什么没填，
    // 否则看起来像识别失败（实测：把实习经历填进「工作经历」区块就是这么发生的）
    for (const g of (segPlan && segPlan.excluded) || []) {
      const title = g.title || g.keptTitle || "某区块";
      if (g.why === "skip-section") {
        notes.push(`页面上「${title}」区块按设计整块跳过：这里的字段不属于求职者本人，自动填会张冠李戴（例如家属的「工作单位」被填成你自己的公司）。`);
      } else if (g.why === "other-section") {
        notes.push(
          `页面上「${title}」区块没有填：档案里没有这一类经历。` +
            `它的字段和「${g.section ? g.section.label : "其它经历"}」完全同形，自动填会把数据填错位置，所以整块跳过。`
        );
      } else if (g.why === "duplicate-kept-other") {
        notes.push(`页面上还有一处重复的「${g.section.label}」区块（标题「${title}」）没有填，请手动核对。`);
      } else {
        notes.push(`页面上「${title}」区块没有填，请手动核对。`);
      }
    }

    if (l3 && l3.enabled) {
      if (l3.filled) {
        notes.push(
          `大模型补上了 ${l3.filled} 个规则没认出来的字段（标为待确认，请核对${l3.cached ? "；本次用了本站缓存，没有重新请求" : ""}）。`
        );
      } else if (l3.error) {
        notes.push(`大模型补字段没成功（${l3.error}），已按规则匹配的结果填充。`);
      } else if (l3.asked) {
        notes.push(`大模型看过 ${l3.asked} 个未识别字段，没有给出有把握的对应关系，需要你手动点一下。`);
      }
    }

    return notes;
  }

  async function runFill() {
    if (busy) return { ok: false, error: "上一次填充还在进行中" };
    busy = true;
    try {
      const host = hostKey();
      // 传 host：只在当前站点生效的自定义类目才纳入（空的类目对谁都生效）
      const dict = await RFA.dict.load(false, { host });
      const profile = await RFA.profile.get();

      let candidates = RFA.scan.scan(document);
      if (!candidates.length) return { ok: true, count: 0, summary: null };

      // 1. 多段经历：段数不足先点「添加」补齐，补齐后必须重新扫描
      let seg = { added: 0, missing: [], groups: [] };
      try {
        seg = await RFA.repeatable.ensure(candidates, dict, profile);
        if (seg.added) candidates = RFA.scan.scan(document);
      } catch (err) {
        RFA.log("多段经历处理失败，已跳过", err);
      }

      // 2. 手动映射先算出来：它的优先级高于一切自动匹配
      const manualMap = await RFA.manual.loadAll();
      const manualPairs = RFA.manual.applyManual(candidates, dict, profile, host, manualMap);

      // 3. 段内作用域匹配 + 段外全局匹配（scopedIdx 把两者隔开，防串段）
      const segPlan = RFA.repeatable.plan(candidates, dict, profile);
      const rest = candidates.filter((c) => !segPlan.scopedIdx.has(c.idx));
      const auto = RFA.match.matchAll(rest, dict, profile);

      const matched = {
        pairs: auto.pairs.concat(segPlan.pairs),
        ignored: auto.ignored.concat(segPlan.ignored),
        unmatched: auto.unmatched.concat(segPlan.unmatched)
      };

      // 4. L1 适配器
      let adapterId = null;
      try {
        const adapter = RFA.adapters.detect(document, host);
        if (adapter) {
          adapterId = adapter.id;
          applyAdapters(matched, candidates, dict, profile, adapter);
        }
      } catch (err) {
        RFA.log("适配器执行失败，已忽略", err);
      }

      // 5. 手动映射覆盖自动匹配
      const merged = RFA.manual.mergeWithAuto(matched.pairs, manualPairs, dict);
      matched.pairs = merged.pairs;
      // 手动生效的控件不能继续留在「未识别」里，否则同一控件会同时出现在两栏（实测踩过）
      if (merged.manualIdx.size) {
        matched.unmatched = matched.unmatched.filter((c) => !merged.manualIdx.has(c.idx));
      }

      // 6. L3：规则认不出来的字段交给大模型（可选，见 core/llm-match.js）
      let l3 = { enabled: false, asked: 0, filled: 0 };
      try {
        l3 = await runL3(candidates, dict, profile, matched, segPlan);
      } catch (err) {
        RFA.log("L3 执行失败，已跳过", err);
        l3 = { enabled: true, asked: 0, filled: 0, error: String((err && err.message) || err) };
      }

      // 7. 值格式校验：不通过就不填（DESIGN.md 6.3 的防错填机制）
      const fillable = [];
      const byIdx = new Map();
      for (const pair of matched.pairs) {
        const err = RFA.profile.validateValue(pair.value, pair.field);
        if (err) {
          byIdx.set(pair.cand.idx, { status: "failed", actual: "", note: err });
        } else {
          fillable.push(pair);
        }
      }

      const results = await RFA.fill.fillAll(fillable, dict);
      fillable.forEach((pair, i) => byIdx.set(pair.cand.idx, results[i]));

      const aligned = matched.pairs.map(
        (pair) => byIdx.get(pair.cand.idx) || { status: "failed", actual: "", note: "没有拿到填充结果" }
      );

      const report = RFA.report.build(matched, aligned, dict);
      report.adapterId = adapterId;
      report.notes = buildNotes(seg, segPlan, l3);
      report.manualCount = manualPairs.length;
      report.llmCount = l3.filled || 0;

      lastReport = report;
      lastCandidates = candidates;
      lastDict = dict;
      lastProfile = profile;
      lastGroups = segPlan.groups;

      RFA.overlay.hideLauncher();
      RFA.overlay.showMarks(report.entries, onBadgeClick);
      RFA.overlay.showPanel(report);

      return { ok: true, count: candidates.length, summary: RFA.report.serialize(report) };
    } catch (err) {
      RFA.log("填充过程出错", err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    } finally {
      busy = false;
    }
  }

  /* ---------- 手动指定字段（覆盖率兜底） ---------- */

  /** 按段号取好每个字段的预览值，选择器里显示的就是「选它之后会填进去什么」 */
  function pickerValues(dict, profile, arrayIndex) {
    const values = {};
    for (const f of dict.fields) {
      const v = RFA.profile.formatForInput(RFA.profile.getValue(profile, f.key, arrayIndex || 0));
      if (v) values[f.key] = v;
    }
    return values;
  }

  function onBadgeClick(entry) {
    if (!entry || !lastDict) return;
    const cand = lastCandidates.find((c) => c.idx === entry.idx);
    const host = hostKey();
    const segPos = RFA.repeatable.segmentIndexOf(cand && cand.el, lastGroups);
    const arrayIndex = segPos ? segPos.index : 0;

    RFA.overlay.showPicker({
      entry,
      sections: lastDict.sections,
      values: pickerValues(lastDict, lastProfile, arrayIndex),
      mappedFieldKey: entry.fieldKey,
      onPick: (fieldKey) => assignField(entry.idx, fieldKey),
      onClear: entry.manual ? () => unassignField(entry.idx) : null,
      onCreateNew: (name, value) => createAndAssign(entry.idx, name, value)
    });
  }

  /* ---------- 就地新建自定义字段（覆盖率飞轮） ---------- */

  const AUTO_CATEGORY = "网页上新增的字段";

  /**
   * 用页面上的标签就地新建一列自定义字段，并且可以顺手把值也填上。
   *
   * 为什么放在这里而不是只放在设置页：用户遇到「档案里根本没这一栏」的时刻，
   * 正是最该把它记下来的时刻。要求他离开页面、切到设置页、加列、回来重填，
   * 这条链路太长了，维护习惯就养不起来。这里一次点击就完成「建列 + 记值 + 记住映射」。
   *
   * 新建的列落在「网页上新增的字段」这个类目里（默认对所有网站生效），
   * 用户可以随时在设置页改名或限定网站。
   *
   * @returns {{ok: boolean, key?: string, catId?: string, reused?: boolean, error?: string}}
   */
  async function ensureCustomField(name) {
    const label = String(name || "").trim();
    if (!label) return { ok: false, error: "先给它起个名字" };

    let defs = await RFA.custom.load();

    // 同名（含别名）的列已经存在就复用，不要在用户反复点击下堆出一串重复列
    const hit = RFA.custom.findFieldByLabel(defs, label);
    if (hit) return { ok: true, key: RFA.custom.fieldKey(hit.category.id, hit.field.id), catId: hit.category.id, reused: true };

    let cat = defs.categories.find((c) => c.label === AUTO_CATEGORY);
    if (!cat) {
      defs = RFA.custom.addCategory(defs, AUTO_CATEGORY);
      cat = defs.categories[defs.categories.length - 1];
    }
    defs = RFA.custom.addField(defs, cat.id, label);
    // 同步收敛后再落盘：不要拿 save 的异步返回值回写，否则并发输入会互相覆盖
    defs = RFA.custom.normalizeDefs(defs);
    await RFA.custom.save(defs);

    const saved = RFA.custom.findCategory(defs, cat.id);
    const field = saved && saved.fields[saved.fields.length - 1];
    if (!field) return { ok: false, error: "新建列失败" };
    return { ok: true, key: RFA.custom.fieldKey(cat.id, field.id), catId: cat.id, reused: false };
  }

  /**
   * 建列 →（可选）写值 → 映射 → 填入。任何一步失败都如实返回，不假装成功。
   */
  async function createAndAssign(idx, name, value) {
    const res = await ensureCustomField(name);
    if (!res.ok) return res;

    const text = String(value == null ? "" : value).trim();
    if (text) {
      const profile = await RFA.profile.get();
      RFA.profile.setValue(profile, res.key, text, 0);
      await RFA.profile.save(profile);
      lastProfile = profile;
    }

    // 词典是这次填充开始时算好的，新列还不在里面 —— 补上，
    // 否则下面 assignField 会以「控件已失效」为由拒绝
    lastDict = await RFA.dict.refreshCustom({ host: hostKey() });

    const out = await assignField(idx, res.key);
    return Object.assign({ key: res.key, created: !res.reused, withValue: !!text }, out);
  }

  async function assignField(idx, fieldKey) {
    const cand = lastCandidates.find((c) => c.idx === idx);
    const field = lastDict && lastDict.byKey[fieldKey];
    if (!cand || !field) return { ok: false, error: "控件已失效，请重新点一次填充" };

    const host = hostKey();
    const segPos = RFA.repeatable.segmentIndexOf(cand.el, lastGroups);
    // 段内的字段要取档案里对应那一段的值，否则手动指定会把第 3 段填成第 1 段的内容
    const arrayIndex = segPos && field.key.indexOf("[].") > 0 ? segPos.index : 0;

    await RFA.manual.set(host, RFA.manual.keyOf(cand, host), { fieldKey, label: field.label, arrayIndex });

    const value = RFA.profile.formatForInput(RFA.profile.getValue(lastProfile, field.key, arrayIndex));
    if (!value) {
      RFA.overlay.updateEntry(idx, {
        manual: true,
        fieldKey,
        fieldLabel: field.label,
        status: "unmatched",
        note: `已记住映射，但档案里「${field.label}」还是空的`
      });
      return { ok: true, note: `${field.label} 在档案里还是空的` };
    }

    const invalid = RFA.profile.validateValue(value, field);
    if (invalid) {
      RFA.overlay.updateEntry(idx, {
        manual: true,
        fieldKey,
        fieldLabel: field.label,
        status: "failed",
        note: invalid
      });
      return { ok: false, note: invalid };
    }

    let res;
    try {
      // 手动指定是用户显式操作：既使页面上已有内容，也按用户的选择覆盖
      res = (await RFA.fill.fillAll([{ cand, field, value, score: 100, manual: true }], lastDict, { force: true }))[0];
    } catch (err) {
      res = { status: "failed", actual: "", note: String((err && err.message) || err) };
    }

    RFA.overlay.updateEntry(idx, {
      manual: true,
      fieldKey,
      fieldLabel: field.label,
      score: 100,
      level: "ok",
      status: res.status === "filled" ? "filled" : "failed",
      note: res.status === "filled" ? "手动指定" : res.note,
      actual: res.actual || ""
    });

    return { ok: res.status === "filled", note: res.note };
  }

  async function unassignField(idx) {
    const cand = lastCandidates.find((c) => c.idx === idx);
    if (!cand) return { ok: false, error: "控件已失效" };
    await RFA.manual.remove(hostKey(), RFA.manual.keyOf(cand, hostKey()));
    RFA.overlay.updateEntry(idx, {
      manual: false,
      fieldKey: null,
      fieldLabel: null,
      score: 0,
      level: "unmatched",
      status: "unmatched",
      note: "",
      actual: ""
    });
    return { ok: true };
  }

  /* ---------- 与 popup 的通信 ---------- */

  async function countFields() {
    try {
      return RFA.scan.scan(document).length;
    } catch (err) {
      return 0;
    }
  }

  function clearOverlay() {
    RFA.overlay.clear();
  }

  /**
   * 首次进入页面时，如果看着像表单页，就在右下角挂一个「一键填充」按钮
   * （对齐竞品的交互：用户不需要先去点扩展图标）。
   */
  async function maybeShowLauncher() {
    const raw = document.querySelectorAll("input, select, textarea").length;
    if (raw < 6) return;

    // countFields 是 async：不 await 的话拿到的是 Promise。
    // 后果有两个：① count < 3 变成 Promise < 3 → NaN < 3 → 恒 false，阈值守卫失效，
    // 一个字段都认不出的页面也照样挂按钮；② Promise 被拼进按钮文字，渲染成
    // 「填充简历（[object Promise] 项）」。两条都在真实快照里复现过。
    const count = await countFields();
    if (count < 3) return;
    RFA.overlay.showLauncher(count, () => {
      runFill();
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "RFA") return undefined;

    (async () => {
      try {
        switch (msg.action) {
          case "ping": {
            // 同 maybeShowLauncher：必须 await，Promise 塞进 sendResponse 会结构化克隆失败
            const count = await countFields();
            sendResponse({ ok: true, count, url: location.href });
            break;
          }
          case "fill":
            sendResponse(await runFill());
            break;
          case "clear":
            clearOverlay();
            sendResponse({ ok: true });
            break;
          case "assign":
            sendResponse(await assignField(msg.idx, msg.fieldKey));
            break;
          case "unassign":
            sendResponse(await unassignField(msg.idx));
            break;
          case "manualCount": {
            const all = await RFA.manual.loadAll();
            sendResponse({ ok: true, count: RFA.manual.listByHost(all, hostKey()).length });
            break;
          }
          case "manualClear": {
            const n = await RFA.manual.clearHost(hostKey());
            sendResponse({ ok: true, removed: n });
            break;
          }
          default:
            sendResponse({ ok: false, error: `未知动作：${msg.action}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();

    return true; // 保持消息通道，异步响应
  });

  // DOM 可能还在渲染（很多网申页是 SPA），延迟一点再判断要不要挂启动按钮
  if (document.readyState === "complete") {
    setTimeout(maybeShowLauncher, 700);
  } else {
    window.addEventListener("load", () => setTimeout(maybeShowLauncher, 700), { once: true });
  }

  window.addEventListener("scroll", () => RFA.overlay.scheduleReposition(), { passive: true });
  window.addEventListener("resize", () => RFA.overlay.scheduleReposition(), { passive: true });

  RFA.content = {
    runFill,
    countFields,
    assignField,
    unassignField,
    createAndAssign,
    getReport: () => lastReport
  };
})();
