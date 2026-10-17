/**
 * 简历档案的读写。
 *
 * 存储位置：chrome.storage.local 的 "profile" 键（DESIGN.md 3：数据默认全部留在本机）。
 * 档案 key 的两种形态：
 *   - "contact.mobile"        → profile.contact.mobile
 *   - "educations[].school"   → profile.educations[i].school（i 为第几段经历）
 */
(function () {
  const RFA = globalThis.__RFA;

  const KEY = "profile";

  function emptyProfile() {
    return {
      version: 1,
      basic: {},
      identity: {},
      contact: {},
      educations: [],
      internships: [],
      projects: [],
      campus: [],
      skills: {},
      job: {},
      open: {},
      assets: {}
    };
  }

  async function get() {
    const bag = await chrome.storage.local.get(KEY);
    const stored = bag[KEY] || {};
    // 用空档案兜底，保证所有内置分组都存在，调用方不用做存在性判断。
    // 同时把 storage 里的其它分组（目前只有用户自定义类目的 custom_<id>）一并带出来 ——
    // 只拷内置键的话，用户辛苦维护的自定义值每次读档案都会被无声丢掉。
    const base = emptyProfile();
    for (const k of Object.keys(stored)) {
      if (stored[k] !== undefined) base[k] = stored[k];
    }
    return base;
  }

  async function save(profile) {
    await chrome.storage.local.set({ [KEY]: profile });
    return profile;
  }

  async function clear() {
    await chrome.storage.local.set({ [KEY]: emptyProfile() });
  }

  function parseKey(key) {
    if (key.includes("[].")) {
      const [arr, field] = key.split("[].");
      return { array: arr, field, isArray: true };
    }
    const [group, field] = key.split(".");
    return { group, field, isArray: false };
  }

  /** 取档案里的值；数组型字段用 arrayIndex 定位第几段 */
  function getValue(profile, key, arrayIndex = 0) {
    const p = parseKey(key);
    if (p.isArray) {
      const list = profile[p.array];
      if (!Array.isArray(list)) return undefined;
      const item = list[arrayIndex];
      return item ? item[p.field] : undefined;
    }
    const group = profile[p.group];
    return group ? group[p.field] : undefined;
  }

  function setValue(profile, key, value, arrayIndex = 0) {
    const p = parseKey(key);
    if (p.isArray) {
      if (!Array.isArray(profile[p.array])) profile[p.array] = [];
      while (profile[p.array].length <= arrayIndex) profile[p.array].push({});
      profile[p.array][arrayIndex][p.field] = value;
      return profile;
    }
    if (!profile[p.group] || typeof profile[p.group] !== "object") profile[p.group] = {};
    profile[p.group][p.field] = value;
    return profile;
  }

  /** 数组值（如证书列表）填进单行文本框时用顿号连接 */
  function formatForInput(value) {
    if (value == null) return "";
    if (Array.isArray(value)) return value.filter(Boolean).join("；");
    if (typeof value === "object") return "";
    return String(value);
  }

  /** 从出生日期推算年龄：档案里没显式填 age 时兜底 */
  function deriveValue(profile, key) {
    if (key === "basic.age") {
      const bd = profile.basic && profile.basic.birthDate;
      if (!bd) return "";
      const m = String(bd).match(/(\d{4})[-/年.]?(\d{1,2})?/);
      if (!m) return "";
      const now = new Date();
      let age = now.getFullYear() - Number(m[1]);
      if (m[2]) {
        const month = Number(m[2]);
        if (now.getMonth() + 1 < month) age -= 1;
      }
      return age > 0 && age < 100 ? String(age) : "";
    }
    return "";
  }

  /** 身份证 18 位校验位验证（DESIGN.md 6.3：命中后必跑格式校验，防错填） */
  function isValidIdNumber(id) {
    const s = String(id).trim().toUpperCase();
    if (!/^\d{17}[\dX]$/.test(s)) return false;
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const codes = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += Number(s[i]) * weights[i];
    return codes[sum % 11] === s[17];
  }

  /**
   * 值格式校验。返回 null 表示通过，否则返回失败原因。
   * 只校验 schema 里声明了 validate 的字段；其余字段不做格式假设。
   */
  function validateValue(value, field) {
    const v = formatForInput(value).trim();
    if (!v) return null;

    if (field.key === "identity.idNumber") {
      return isValidIdNumber(v) ? null : "身份证号校验位不通过";
    }
    if (!field.validate) return null;

    let re;
    try {
      re = new RegExp(field.validate);
    } catch (_) {
      return null;
    }
    return re.test(v) ? null : `不符合格式要求（${field.validateName || "格式"}）`;
  }

  /* ---------- 导入归一化（档案多半是用户拿简历让外部大模型按模板生成的） ---------- */

  /**
   * 把「2025年7月」「2025/07/01」「2025.7」这类写法收敛成 YYYY-MM。
   * 认不出来就返回 null，由调用方保留原值 —— 宁可不改，也不要猜错时间。
   */
  function toYearMonth(s) {
    const m = String(s).match(/(\d{4})\s*[-/.年]\s*(\d{1,2})/);
    if (!m) return null;
    const mm = Number(m[2]);
    if (mm < 1 || mm > 12) return null;
    return `${m[1]}-${String(mm).padStart(2, "0")}`;
  }

  function toDate(s) {
    const m = String(s).match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
    if (!m) return null;
    const mm = Number(m[2]);
    const dd = Number(m[3]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `${m[1]}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  /**
   * 枚举值归一：模型爱写「本科（学士）」「男性」这类页面用语。
   * 先看是否已在候选里，再查 valueNormalization 的人工映射，最后原样保留（并记警告）。
   */
  function coerceEnum(value, field, dict) {
    if (!field.enum || !field.enum.length) return value;
    if (field.enum.includes(value)) return value;

    const examples = dict && dict.valueNormalization && dict.valueNormalization.examples;
    const fieldMap = examples && examples[field.key];
    if (fieldMap) {
      for (const [canonical, alts] of Object.entries(fieldMap)) {
        if ([canonical].concat(alts || []).includes(value)) return canonical;
      }
    }

    // 包含关系兜底，但只认「唯一命中」：
    // 「未婚（未育）」能唯一收敛成「未婚」，而同时命中两个候选的值
    //（例如「群众和民主党派」）就不该替用户做决定 —— 那是有歧义的，交给警告让人自己看。
    if (value.length >= 2) {
      const hits = field.enum.filter((o) => o && o.length >= 2 && (value.includes(o) || o.includes(value)));
      if (hits.length === 1) return hits[0];
    }
    return value;
  }

  function coerceValue(value, field, dict, warnings) {
    if (value == null) return "";
    if (Array.isArray(value)) {
      return value
        .map((v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v)))
        .filter((v) => v !== "");
    }
    if (typeof value === "object") return ""; // 模型偶尔给出嵌套对象，丢掉不猜
    let s = String(value).trim();
    if (!s) return "";

    if (field.type === "dateYm") {
      s = toYearMonth(s) || s;
    } else if (field.type === "date") {
      s = toDate(s) || s;
    } else if (field.type === "array") {
      return s
        .split(/[；;\n、]+/)
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (field.type === "enum") {
      const before = s;
      s = coerceEnum(s, field, dict);
      if (s !== before) return s;
      if (field.enum && !field.enum.includes(s)) {
        warnings.push({ fieldKey: field.key, label: field.label, value: s, reason: "不在候选值里" });
      }
    }
    return s;
  }

  /**
   * 把外部 JSON（多半由大模型按 tools/make-import-kit.mjs 生成的模板产出）收敛成合法档案。
   *
   * 做四件事：
   *   1. 丢掉 `$` 开头的说明键，以及 schema 里没有的键（脏数据不进档案）；
   *   2. 日期 / 枚举 / 多值字段做温和归一；
   *   3. 整段都是空的经历对象直接丢弃（模板里的空骨架会被模型原样带回）；
   *   4. 枚举值不在候选内时记警告，让用户在导入时就看见，而不是等到页面上填不上。
   *
   * @returns {{profile: Object, warnings: Array, filled: number, droppedSegments: number}}
   */
  function coerceImported(raw, dict) {
    const base = emptyProfile();
    const warnings = [];
    let filled = 0;
    let droppedSegments = 0;

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { profile: base, warnings, filled, droppedSegments };
    }

    for (const field of dict.fields) {
      if (field.key.includes("[].")) continue;
      const p = parseKey(field.key);
      const group = raw[p.group];
      if (!group || typeof group !== "object" || Array.isArray(group)) continue;
      const v = coerceValue(group[p.field], field, dict, warnings);
      if (v === "" || (Array.isArray(v) && !v.length)) continue;
      // 自定义类目的分组不在 emptyProfile 的固定清单里，得按需建出来
      if (!base[p.group] || typeof base[p.group] !== "object") base[p.group] = {};
      base[p.group][p.field] = v;
      filled++;
    }

    const arrayNames = [
      ...new Set(dict.fields.filter((f) => f.key.includes("[].")).map((f) => parseKey(f.key).array))
    ];
    for (const arr of arrayNames) {
      const list = raw[arr];
      if (!Array.isArray(list)) continue;
      const segFields = dict.fields.filter((f) => f.key.startsWith(`${arr}[].`));
      const kept = [];
      for (const item of list) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const seg = {};
        for (const f of segFields) {
          const name = parseKey(f.key).field;
          const v = coerceValue(item[name], f, dict, warnings);
          if (v === "" || (Array.isArray(v) && !v.length)) continue;
          seg[name] = v;
          filled++;
        }
        if (Object.keys(seg).length) kept.push(seg);
        else droppedSegments++;
      }
      if (kept.length) base[arr] = kept;
    }

    return { profile: base, warnings, filled, droppedSegments };
  }

  /** 统计档案的完整度，用于 popup 提示「档案还没录入」 */
  function stats(profile, dict) {
    let filled = 0;
    let required = 0;
    let requiredFilled = 0;
    for (const f of dict.fields) {
      const v = formatForInput(getValue(profile, f.key, 0));
      if (v) filled++;
      if (f.required) {
        required++;
        if (v) requiredFilled++;
      }
    }
    return { filled, total: dict.fields.length, required, requiredFilled };
  }

  RFA.profile = {
    KEY,
    emptyProfile,
    get,
    save,
    clear,
    parseKey,
    getValue,
    setValue,
    formatForInput,
    deriveValue,
    validateValue,
    isValidIdNumber,
    stats,
    coerceImported,
    coerceValue,
    coerceEnum,
    toYearMonth,
    toDate
  };
})();
