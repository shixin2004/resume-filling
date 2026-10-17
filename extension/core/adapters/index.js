/**
 * 站点适配器（L1，DESIGN.md 6.2 与第 9 节）。
 *
 * 目前是空注册表：M0/M1 完全依赖 L2 启发式匹配。
 * M2 会在这里注册 moka / beisen / feishu / dayee。
 *
 * 维护纪律：只把 L2 打不中的字段写进 fields，不要重复 L2 能干的事，
 * 否则适配器会随页面改版一起腐烂。
 *
 * 一个适配器的形态：
 *   RFA.adapters.register({
 *     id: "moka",
 *     name: "Moka",
 *     detect: ({ doc, host }) => !!doc.querySelector('[class*="mx-"]'),
 *     fields: { '[data-testid="apply-name"]': "basic.nameCn" }
 *   });
 */
(function () {
  const RFA = globalThis.__RFA;

  const registry = [];

  function register(adapter) {
    registry.push(adapter);
    return adapter;
  }

  /** 按注册顺序找第一个命中的适配器 */
  function detect(doc, host) {
    for (const adapter of registry) {
      try {
        if (adapter.detect && adapter.detect({ doc, host })) return adapter;
      } catch (err) {
        RFA.log("适配器 detect 抛错：", adapter.id, err);
      }
    }
    return null;
  }

  /**
   * 用适配器给候选控件指定档案字段。
   * @returns {Map<number, string>} idx → profileKey
   */
  function apply(adapter, candidates) {
    const hits = new Map();
    if (!adapter || !adapter.fields) return hits;

    for (const cand of candidates) {
      for (const [selector, key] of Object.entries(adapter.fields)) {
        try {
          if (cand.el.matches && cand.el.matches(selector)) {
            hits.set(cand.idx, key);
            break;
          }
        } catch (err) {
          RFA.log("适配器选择器非法：", selector, err);
        }
      }
    }
    return hits;
  }

  RFA.adapters = { register, detect, apply, registry };
})();
