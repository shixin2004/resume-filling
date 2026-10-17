/**
 * 词典加载：字段定义（profile.schema.json）+ 别名表（field-aliases.json）+ 用户自定义字段。
 *
 * 设计约定（DESIGN.md 5.1）：字段名与别名一律从数据文件读，
 * 代码里禁止硬编码字段 key 或中文别名。
 *
 * 加载顺序：优先用 chrome.storage.local 里的缓存；没有则 fetch 扩展内的 JSON 并回写缓存。
 *
 * 两个层次要分清：
 *   - 「基础词典」= schema + 别名，来自只读文件，缓存后基本不动；
 *   - 「自定义字段」= 用户在设置页维护的类目与列（core/custom.js），存在另一个 storage 键里。
 * 每次 load() 都会把自定义字段重新读一遍再并进来 —— 用户在设置页改了列名，
 * 刷新页面就生效，不需要「重载词典」。
 */
(function () {
  const RFA = globalThis.__RFA;

  const K = {
    schema: "dict:schema",
    aliases: "dict:aliases",
    loadedAt: "dict:loadedAt"
  };

  let baseDict = null;

  async function fetchFromDisk() {
    const [schemaRes, aliasRes] = await Promise.all([
      fetch(chrome.runtime.getURL("data/profile.schema.json")),
      fetch(chrome.runtime.getURL("data/field-aliases.json"))
    ]);
    const schema = await schemaRes.json();
    const aliasDoc = await aliasRes.json();
    return { schema, aliases: aliasDoc.aliases || {} };
  }

  function build(schema, aliases) {
    const fields = [];
    const byKey = Object.create(null);

    for (const sec of schema.sections || []) {
      for (const f of sec.fields || []) {
        const item = {
          key: f.key,
          label: f.label,
          type: f.type,
          enum: f.enum || null,
          required: !!f.required,
          sensitive: !!f.sensitive,
          maxOccurrence: f.maxOccurrence || 1,
          section: sec.id,
          sectionLabel: sec.label,
          repeatable: !!sec.repeatable,
          orderHint: sec.orderHint || "",
          validateName: f.validate || null,
          validate: f.validate && schema.validators ? schema.validators[f.validate] : null,
          alias: aliases[f.key] || [],
          note: f.note || "",
          example: f.example || ""
        };
        fields.push(item);
        byKey[item.key] = item;
      }
    }

    return {
      schema,
      aliases,
      fields,
      byKey,
      validators: schema.validators || {},
      valueNormalization: schema.valueNormalization || null,
      // 「整块不填」的区块标题（家庭情况 / 紧急联系人…）。
      // 家属的「姓名」「工作单位」和求职者自己的字段同名同形，自动填必然张冠李戴。
      skipSections: schema.skipSections || [],
      sections: (schema.sections || []).map((s) => ({
        id: s.id,
        label: s.label,
        repeatable: !!s.repeatable,
        // 段的区块标题别名（「实习经历」「教育背景」…）。段语义判定的权威信号，
        // 缺了它「工作经历」和「实习经历」这种同形字段的区块就没法区分。
        segmentTitles: s.segmentTitles || [],
        // 明确「不是本段」的区块标题（如 internships 的「工作经历」）。
        // 与 segmentTitles 一样是段语义的输入，漏了就会静默退化成字段打分。
        excludeTitles: s.excludeTitles || [],
        orderHint: s.orderHint || "",
        note: s.note || "",
        fields: (s.fields || []).map((f) => byKey[f.key]).filter(Boolean)
      }))
    };
  }

  /**
   * 载入基础词典（schema + 别名），不含自定义字段。
   * @param {boolean} force 为 true 时忽略缓存，重新从扩展文件读取（options 页的「重载词典」用）
   */
  async function loadBase(force) {
    if (baseDict && !force) return baseDict;

    if (!force) {
      const bag = await chrome.storage.local.get([K.schema, K.aliases]);
      if (bag[K.schema] && bag[K.aliases]) {
        baseDict = build(bag[K.schema], bag[K.aliases]);
        return baseDict;
      }
    }

    const { schema, aliases } = await fetchFromDisk();
    await chrome.storage.local.set({
      [K.schema]: schema,
      [K.aliases]: aliases,
      [K.loadedAt]: Date.now()
    });
    baseDict = build(schema, aliases);
    return baseDict;
  }

  /** 自定义字段模块可能没被加载（静态注入只注了部分文件时），那样就退化成只有内置字段 */
  function customMod() {
    return RFA.custom || null;
  }

  /**
   * 载入完整词典（基础 + 自定义）。
   * @param {boolean} force 忽略缓存重读基础词典
   * @param {Object} [opts]  { host } —— 传了就只纳入适用该站点的自定义类目；
   *                        不传 = 全部纳入（设置页就是这么用的）。
   */
  async function load(force, opts) {
    const base = await loadBase(force);
    const custom = customMod();
    if (!custom) return base;
    return custom.merge(base, await custom.load(), opts);
  }

  /**
   * 只重算自定义字段那部分（设置页编辑列名时用）。
   * 不重读 schema 文件 —— 编辑一个字就重新 fetch 两个 JSON 太浪费。
   */
  async function refreshCustom(opts) {
    const base = await loadBase(false);
    const custom = customMod();
    if (!custom) return base;
    return custom.merge(base, await custom.load(), opts);
  }

  /** 只读磁盘版本，用于 options 页在重载后回写缓存 */
  async function reloadFromDisk() {
    await loadBase(true);
    const custom = customMod();
    if (!custom) return baseDict;
    return custom.merge(baseDict, await custom.load());
  }

  RFA.dict = {
    load,
    loadBase,
    refreshCustom,
    reloadFromDisk,
    get: () => baseDict,
    keys: K
  };
})();
