/**
 * 用户自定义类目与字段。
 *
 * 内置词典（profile.schema.json + field-aliases.json）是只读的静态文件，覆盖的是
 * 「所有求职者都会遇到」的字段。但真实网申页总有一些站点自己的问法（「生源地」
 * 「是否服从调剂」「应聘渠道」…），兜不住的那些只能靠用户自己教一遍。
 *
 * 这个模块就是「教」的落点：用户在设置页加一个类目、加几列，写一次值，
 * 从此这类字段走和内置字段完全一样的匹配/填充链路 —— 不需要为每个网站写适配器。
 *
 * 数据形状（chrome.storage.local 的 "customFields" 键）：
 *   {
 *     version: 1,
 *     nextCatId: 3,                       // 单调递增，删除后也不复用
 *     categories: [
 *       { id: "1", label: "某行网申特有", hosts: ["zhiye.com"], nextFieldId: 2,
 *         fields: [{ id: "f1", label: "生源地", aliases: ["生源所在地"] }] }
 *     ]
 *   }
 *
 * 档案里的键：`custom_<catId>.<fieldId>` —— 刻意沿用 `分组.字段` 的形式，
 * 这样档案读写（profile.parseKey）、区段匹配、报告、手动指定选择器全都不用改。
 *
 * 值只存在本机；自定义字段一律按 text 处理（用户明确要求保持单一：不要类型下拉，
 * 只要输入框），因此也没有枚举归一、日期拆分量这些分支。
 */
(function () {
  const RFA = globalThis.__RFA;
  const N = RFA.N;

  const KEY = "customFields";
  const VERSION = 1;
  const PREFIX = "custom_";
  const UNNAMED = "（未命名列）";

  function empty() {
    return { version: VERSION, nextCatId: 1, categories: [] };
  }

  /* ---------- 读写 ---------- */

  /**
   * 把 storage 里读到的东西收敛成合法结构。
   * 外部（旧版本、手改、导入）来的数据一律走这里，宁可丢掉怪东西也不让坏数据流进匹配。
   */
  function normalizeDefs(raw) {
    const base = empty();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;

    const cats = Array.isArray(raw.categories) ? raw.categories : [];
    let maxId = 0;

    for (const c of cats) {
      if (!c || typeof c !== "object") continue;
      const id = String(c.id == null ? "" : c.id).replace(/[^0-9]/g, "");
      if (!id) continue;
      maxId = Math.max(maxId, Number(id));

      const fields = [];
      for (const f of Array.isArray(c.fields) ? c.fields : []) {
        if (!f || typeof f !== "object") continue;
        const fid = String(f.id == null ? "" : f.id).replace(/[^A-Za-z0-9]/g, "");
        if (!fid) continue;
        fields.push({
          id: fid,
          label: String(f.label == null ? "" : f.label).trim(),
          aliases: parseAliases(Array.isArray(f.aliases) ? f.aliases.join("、") : f.aliases)
        });
      }

      base.categories.push({
        id,
        label: String(c.label == null ? "" : c.label).trim(),
        hosts: parseHosts(Array.isArray(c.hosts) ? c.hosts.join(",") : c.hosts),
        nextFieldId: Math.max(Number(c.nextFieldId) || 1, fields.length + 1),
        fields
      });
    }

    base.nextCatId = Math.max(Number(raw.nextCatId) || 1, maxId + 1);
    return base;
  }

  async function load() {
    const bag = await chrome.storage.local.get(KEY);
    return normalizeDefs(bag && bag[KEY]);
  }

  async function save(defs) {
    const clean = normalizeDefs(defs);
    await chrome.storage.local.set({ [KEY]: clean });
    return clean;
  }

  /* ---------- 文本 ↔ 列表 ---------- */

  /** 别名输入框的解析：「生源地, 生源所在地、籍贯地」→ 三项 */
  function parseAliases(text) {
    if (Array.isArray(text)) text = text.join("、");
    return String(text == null ? "" : text)
      .split(/[\s,，、;；|/]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s, i, arr) => arr.indexOf(s) === i);
  }

  function formatAliases(list) {
    return (list || []).join("、");
  }

  /** 限定网站的解析：允许用户粘 "https://job.zhiye.com/campus" 这种整串 */
  function parseHosts(text) {
    if (Array.isArray(text)) text = text.join(",");
    return String(text == null ? "" : text)
      .split(/[\s,，、;；]+/)
      .map((s) => stripPort(s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")))
      .filter(Boolean)
      .filter((s, i, arr) => arr.indexOf(s) === i);
  }

  /** 比对时忽略端口：本地调试的页面是 127.0.0.1:5173 这种，用户只会填到域名 */
  function stripPort(h) {
    return String(h == null ? "" : h).replace(/:\d+$/, "");
  }

  function formatHosts(list) {
    return (list || []).join("、");
  }

  /* ---------- 键名 ---------- */

  /** 类目对应的档案分组名：custom_1 */
  function groupOf(catId) {
    return `${PREFIX}${catId}`;
  }

  /** 类目在词典 sections 里的 id，与档案分组同名 */
  function sectionIdOf(catId) {
    return groupOf(catId);
  }

  /** 字段在档案里的键：custom_1.f1 */
  function fieldKey(catId, fieldId) {
    return `${PREFIX}${catId}.${fieldId}`;
  }

  /* ---------- 增删改（纯函数，返回新的 defs） ---------- */

  function addCategory(defs, label) {
    const id = String(Number(defs.nextCatId) || 1);
    const cat = { id, label: String(label || "").trim() || "新类目", hosts: [], nextFieldId: 1, fields: [] };
    return Object.assign({}, defs, { nextCatId: Number(id) + 1, categories: defs.categories.concat([cat]) });
  }

  function removeCategory(defs, catId) {
    return Object.assign({}, defs, {
      categories: defs.categories.filter((c) => c.id !== catId)
    });
  }

  function addField(defs, catId, label) {
    const categories = defs.categories.map((c) => {
      if (c.id !== catId) return c;
      const n = Number(c.nextFieldId) || 1;
      const field = { id: `f${n}`, label: String(label || "").trim(), aliases: [] };
      return Object.assign({}, c, { nextFieldId: n + 1, fields: c.fields.concat([field]) });
    });
    return Object.assign({}, defs, { categories });
  }

  function removeField(defs, catId, fieldId) {
    const categories = defs.categories.map((c) =>
      c.id === catId ? Object.assign({}, c, { fields: c.fields.filter((f) => f.id !== fieldId) }) : c
    );
    return Object.assign({}, defs, { categories });
  }

  function patchCategory(defs, catId, patch) {
    const categories = defs.categories.map((c) => {
      if (c.id !== catId) return c;
      const next = Object.assign({}, c);
      if (patch.label !== undefined) next.label = String(patch.label).trim();
      if (patch.hosts !== undefined) next.hosts = parseHosts(patch.hosts);
      return next;
    });
    return Object.assign({}, defs, { categories });
  }

  function patchField(defs, catId, fieldId, patch) {
    const categories = defs.categories.map((c) => {
      if (c.id !== catId) return c;
      return Object.assign({}, c, {
        fields: c.fields.map((f) => {
          if (f.id !== fieldId) return f;
          const next = Object.assign({}, f);
          if (patch.label !== undefined) next.label = String(patch.label).trim();
          if (patch.aliases !== undefined) next.aliases = parseAliases(patch.aliases);
          return next;
        })
      });
    });
    return Object.assign({}, defs, { categories });
  }

  /** 找字段归属的类目（给「用页面标签新建字段」用） */
  function findCategory(defs, catId) {
    return defs.categories.find((c) => c.id === catId) || null;
  }

  /**
   * 按列名（或别名）找已存在的列 —— 去重用的。
   * 用户在页面上连点两次「新建」不该在设置页堆出两行一模一样的列。
   */
  function findFieldByLabel(defs, label) {
    const t = N.normalize(label || "");
    if (!t) return null;
    for (const category of (defs && defs.categories) || []) {
      for (const field of category.fields) {
        if (N.normalize(field.label) === t) return { category, field };
        if ((field.aliases || []).some((a) => N.normalize(a) === t)) return { category, field };
      }
    }
    return null;
  }

  function counts(defs) {
    const cats = (defs && defs.categories) || [];
    return {
      categories: cats.length,
      fields: cats.reduce((n, c) => n + c.fields.length, 0)
    };
  }

  /* ---------- 适用范围 ---------- */

  /**
   * 这个类目在当前站点生效吗。
   * hosts 为空 = 所有网站；否则按域名后缀匹配（填 zhiye.com 能覆盖 campus.zhiye.com）。
   * 端口不参与比对 —— 本地调试页是 127.0.0.1:5173，用户只会填到域名。
   */
  function hostMatches(host, hosts) {
    if (!hosts || !hosts.length) return true;
    const h = stripPort(String(host == null ? "" : host).toLowerCase());
    if (!h) return false;
    return hosts.some((x) => h === x || h.endsWith(`.${x}`));
  }

  /* ---------- 并入词典 ---------- */

  /** 一个类目 → 词典字段项。全部按 text 处理，键与内置字段同形 */
  function toDictFields(cat) {
    return cat.fields.map((f) => ({
      key: fieldKey(cat.id, f.id),
      label: f.label || UNNAMED,
      type: "text",
      enum: null,
      required: false,
      sensitive: false,
      maxOccurrence: 1,
      section: sectionIdOf(cat.id),
      sectionLabel: cat.label || "自定义",
      repeatable: false,
      orderHint: "",
      validateName: null,
      validate: null,
      // 别名必须归一化后再进词典：match.js 拿 field.alias 直接和归一化后的页面标签比，
      // 用户写的「生源所在地」不洗一遍就会因为大小写/空格/标点而对不上。
      alias: (f.aliases || []).map(N.normalize).filter(Boolean),
      note: "",
      example: "",
      custom: true,
      categoryId: cat.id,
      hosts: cat.hosts || []
    }));
  }

  /**
   * 把自定义字段并进基础词典。
   *
   * @param {Object} baseDict RFA.dict.loadBase() 的结果（schema + 别名，不含自定义）
   * @param {Object} defs     RFA.custom.load() 的结果
   * @param {Object} [opts]   { host } —— 传了 host 就按站点过滤，**不传就全部纳入**
   *        （设置页要能编辑所有类目，不管当前是什么站点）。
   * @returns {Object} 新的 dict（不修改入参，避免污染缓存）
   */
  function merge(baseDict, defs, opts) {
    const filterByHost = !!(opts && Object.prototype.hasOwnProperty.call(opts, "host"));
    const host = filterByHost ? opts.host : null;

    const active = ((defs && defs.categories) || []).filter(
      (c) => !filterByHost || hostMatches(host, c.hosts)
    );
    if (!active.length) return baseDict;

    const fields = baseDict.fields.slice();
    const byKey = Object.assign(Object.create(null), baseDict.byKey);
    const sections = baseDict.sections.slice();
    let added = 0;

    for (const cat of active) {
      const items = toDictFields(cat);
      if (!items.length) continue; // 还没加列的类目不进词典，免得空壳出现在手动指定列表里
      for (const it of items) {
        fields.push(it);
        byKey[it.key] = it;
        added++;
      }
      sections.push({
        id: sectionIdOf(cat.id),
        label: cat.label || "自定义",
        repeatable: false,
        segmentTitles: [],
        excludeTitles: [],
        orderHint: "",
        note: "",
        custom: true,
        categoryId: cat.id,
        hosts: cat.hosts || [],
        fields: items
      });
    }

    // 一列都没加出来（类目还空着、或者全被站点过滤掉了）：直接返回原词典，
    // 别造一个内容相同的新对象 —— 那样每加一个空类目就多一份词典副本。
    if (!added) return baseDict;

    return Object.assign({}, baseDict, { fields, byKey, sections, customCount: added });
  }

  RFA.custom = {
    KEY,
    PREFIX,
    empty,
    normalizeDefs,
    load,
    save,
    parseAliases,
    formatAliases,
    parseHosts,
    formatHosts,
    groupOf,
    sectionIdOf,
    fieldKey,
    addCategory,
    removeCategory,
    addField,
    removeField,
    patchCategory,
    patchField,
    findCategory,
    findFieldByLabel,
    counts,
    hostMatches,
    toDictFields,
    merge
  };
})();
