/**
 * 手动映射兜底（DESIGN.md 7.9）。
 *
 * 覆盖率的三道防线里最后一道：自动匹配（L1/L2/L3）都认不出来的字段，
 * 让用户点一下红点、从字段列表里选一个 —— 从此这一条**优先级高于一切自动匹配**，
 * 并且记住，下次同一个网站自动生效。
 *
 * 存储：chrome.storage.local 的 "manualMap"。键是「域名 + 控件指纹」，
 * 指纹优先取最可信的标签文本（标签比 id/name 更接近用户看到的那个字段）。
 */
(function () {
  const RFA = globalThis.__RFA;

  const KEY = "manualMap";

  async function loadAll() {
    const bag = await chrome.storage.local.get(KEY);
    return (bag && bag[KEY]) || {};
  }

  async function saveAll(map) {
    await chrome.storage.local.set({ [KEY]: map });
    return map;
  }

  function hostOf() {
    try {
      return location.host || "";
    } catch (_) {
      return "";
    }
  }

  /**
   * 控件的稳定标识。
   * 只认「标签文本 > name > id」，不用 idx —— idx 每次扫描都会变，存下来毫无意义。
   */
  function keyOf(cand, host) {
    const h = host || hostOf();
    const label = (cand.ctx || []).find((c) => c.norm && c.src !== "name" && c.src !== "id");
    if (label) return `${h}|t:${label.norm}`;

    const name = cand.el && cand.el.getAttribute && cand.el.getAttribute("name");
    if (name) return `${h}|n:${name}`;
    if (cand.el && cand.el.id) return `${h}|i:${cand.el.id}`;
    return `${h}|x:${cand.idx}`;
  }

  async function set(host, key, rec) {
    const all = await loadAll();
    all[key] = Object.assign({ host: host || hostOf(), at: Date.now() }, rec);
    return await saveAll(all);
  }

  async function remove(host, key) {
    const all = await loadAll();
    delete all[key];
    return await saveAll(all);
  }

  /** 清除某个域名下的全部映射 */
  async function clearHost(host) {
    const all = await loadAll();
    let n = 0;
    for (const k of Object.keys(all)) {
      if ((all[k] && all[k].host) === host || k.startsWith(`${host}|`)) {
        delete all[k];
        n++;
      }
    }
    await saveAll(all);
    return n;
  }

  function listByHost(all, host) {
    return Object.entries(all).filter(([k, v]) => (v && v.host) === host || k.startsWith(`${host}|`));
  }

  /**
   * 把手动映射变成配对结果。
   * 单选/复选仍要求选项文本对得上（手动的只是「这一组控件属于哪个字段」，
   * 具体勾哪一项还得看值，否则会把「女」勾成用户的性别「男」）。
   */
  function applyManual(candidates, dict, profile, host, map) {
    const pairs = [];
    for (const cand of candidates) {
      const rec = map[keyOf(cand, host)];
      if (!rec || !rec.fieldKey) continue;

      const field = dict.byKey[rec.fieldKey];
      if (!field) continue;

      const value = RFA.profile.formatForInput(RFA.profile.getValue(profile, field.key, rec.arrayIndex || 0));
      if (!value) continue;

      if (cand.kind === "radio" || cand.kind === "checkbox") {
        if (!RFA.match.optionMatchesValue(cand.ownLabel, value, field, dict)) continue;
      }

      pairs.push({ cand, field, score: 100, src: { src: "manual", text: rec.label || "" }, value, manual: true });
    }
    return pairs;
  }

  /**
   * 手动映射覆盖自动匹配。
   * 规则：手动指定的那个控件只用手动结果；它占用的字段，自动配对在数量超过
   * maxOccurrence 时让位（手机号这类允许填两个框的字段不会被一刀切掉）。
   *
   * 返回值里的 manualIdx 必须交给调用方去清理「未识别」列表 ——
   * 手动生效的控件如果还留在未识别里，它就会同时出现在两栏（实测踩过）。
   */
  function mergeWithAuto(autoPairs, manualPairs, dict) {
    const manualIdx = new Set(manualPairs.map((p) => p.cand.idx));
    const countByKey = new Map();
    for (const p of manualPairs) countByKey.set(p.field.key, (countByKey.get(p.field.key) || 0) + 1);

    const kept = [];
    const dropped = [];
    for (const p of autoPairs) {
      if (manualIdx.has(p.cand.idx)) {
        dropped.push(p);
        continue;
      }
      const manualCount = countByKey.get(p.field.key) || 0;
      const limit = (dict.byKey[p.field.key] && dict.byKey[p.field.key].maxOccurrence) || 1;
      if (manualCount > 0 && manualCount >= limit) {
        dropped.push(p);
        continue;
      }
      kept.push(p);
    }

    const pairs = kept.concat(manualPairs).sort((a, b) => a.cand.idx - b.cand.idx);
    return { pairs, dropped, manualIdx };
  }

  RFA.manual = {
    KEY,
    loadAll,
    saveAll,
    keyOf,
    set,
    remove,
    clearHost,
    listByHost,
    applyManual,
    mergeWithAuto
  };
})();
