/**
 * 结果汇总。
 *
 * 产出两类东西：
 *   - 富报告（含 DOM 引用）：给页面浮层做三色标注用；
 *   - 精简摘要（可 JSON 序列化）：给 popup 显示用。
 */
(function () {
  const RFA = globalThis.__RFA;

  /** 给一个候选控件挑一个用于展示的名字 */
  function displayLabel(cand) {
    if (cand.ctx && cand.ctx.length) {
      // 取最靠前（来源最可信）的那条上下文
      const first = cand.ctx[0].text.replace(/\s+/g, " ").trim();
      if (first && first.length <= 30 && !/^[\w-]{1,3}$/.test(first)) return first;
    }
    const el = cand.el;
    if (el) {
      const ph = el.getAttribute && el.getAttribute("placeholder");
      if (ph) return ph.trim();
      const name = el.getAttribute && el.getAttribute("name");
      if (name) return name;
    }
    return `第 ${cand.idx + 1} 个控件`;
  }

  /**
   * @param {{pairs:Array, unmatched:Array, ignored:Array}} matched
   * @param {Array} fillResults 与 matched.pairs 等长的填充结果
   * @param {Object} dict
   */
  function build(matched, fillResults, dict) {
    const entries = [];

    matched.pairs.forEach((pair, i) => {
      const res = fillResults[i] || { status: "failed", note: "无结果" };
      const llm = pair.source === "llm";
      // 大模型给的对应关系必须标出来源：用户要能一眼看出「这条不是规则命中的，得自己看一眼」
      const notes = [];
      if (llm) notes.push(`大模型推断（把握 ${pair.score}%），请核对`);
      if (res.note) notes.push(res.note);

      entries.push({
        idx: pair.cand.idx,
        el: pair.cand.el,
        kind: pair.cand.kind,
        required: pair.cand.required,
        label: displayLabel(pair.cand),
        fieldKey: pair.field.key,
        fieldLabel: pair.field.label,
        sectionLabel: pair.field.sectionLabel,
        segment: pair.segment || "",
        manual: !!pair.manual,
        llm,
        score: pair.score,
        level: RFA.match.levelOf(pair.score),
        status: res.status,
        note: notes.join("；"),
        actual: res.actual,
        value: pair.value
      });
    });

    for (const cand of matched.unmatched) {
      entries.push({
        idx: cand.idx,
        el: cand.el,
        kind: cand.kind,
        required: cand.required,
        label: displayLabel(cand),
        fieldKey: null,
        fieldLabel: null,
        sectionLabel: null,
        segment: "",
        manual: false,
        score: 0,
        level: "unmatched",
        status: "unmatched",
        note: "",
        actual: "",
        value: ""
      });
    }

    return { entries, counts: countBy(entries), notes: [] };
  }

  function countBy(entries) {
    const c = { filled: 0, review: 0, kept: 0, failed: 0, unmatched: 0, requiredUnmatched: 0, total: entries.length };
    for (const e of entries) {
      if (e.status === "unmatched") {
        c.unmatched++;
        if (e.required) c.requiredUnmatched++;
      } else if (e.status === "kept") {
        // 页面原有内容被保留：既不算失败，也不算我们填的
        c.kept++;
      } else if (e.status === "filled") {
        if (e.level === "review") c.review++;
        else c.filled++;
      } else {
        c.failed++;
      }
    }
    return c;
  }

  /** 手动指定字段后重新计数（entries 就地改过，不需要重建） */
  function recount(report) {
    report.counts = countBy(report.entries);
    return report.counts;
  }

  /** 去掉 DOM 引用，得到可以发给 popup 的纯数据 */
  function serialize(report) {
    return {
      counts: report.counts,
      notes: report.notes || [],
      manualCount: report.manualCount || 0,
      entries: report.entries.map((e) => ({
        idx: e.idx,
        kind: e.kind,
        required: e.required,
        label: e.label,
        fieldKey: e.fieldKey,
        fieldLabel: e.fieldLabel,
        sectionLabel: e.sectionLabel,
        segment: e.segment,
        manual: e.manual,
        llm: !!e.llm,
        score: e.score,
        level: e.level,
        status: e.status,
        note: e.note,
        actual: e.actual
      }))
    };
  }

  RFA.report = { build, serialize, displayLabel, recount, countBy };
})();
