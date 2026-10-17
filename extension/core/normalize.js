/**
 * 文本归一化与相似度。
 *
 * 匹配引擎的第一步：把网页上的标签文本（"请输入您的手机号 *"）和别名表里的词（"手机号"）
 * 洗成同一种形态，才能比较。这个文件的正确性直接决定填充率，改动务必跑 tools/selftest.mjs。
 */
(function () {
  const RFA = globalThis.__RFA;

  /** 提示词黑名单：从标签里剥离后剩下的才算真正的标签 */
  const NOISE = [
    "请输入",
    "请填写",
    "请选择",
    "请上传",
    "请如实填写",
    "请如实",
    "请准确",
    "示例",
    "例如",
    "举例",
    "选填",
    "必填",
    "非必填",
    "此项",
    "回车分隔",
    "逗号分隔",
    "多个用",
    "格式",
    "最多",
    "字以内",
    "如无",
    "若无"
  ];

  /** 标点与符号：比较时一律去掉 */
  const PUNCT = /[，。、；：:;,.\-—–_|/\\"'`~!?！？[\]{}<>《》【】·＃#@$%^&+=*＊()]/g;

  /** 全角转半角 + 全角空格转普通空格 */
  function toHalfWidth(s) {
    return String(s)
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, " ");
  }

  /**
   * 剥离提示词。
   * 括号处理有一条额外规则：括号内容含提示词（如「（选填）」「(如：张三)"）整块删掉，
   * 否则保留（如「学历（本科/硕士）」里的选项信息是有用的）。
   *
   * 前缀处理：网申页面的标签普遍带「请输入您的X」「确认X」这类前后缀，
   * 统一剥掉才能落到别名表里的基准词上（"您的手机号" → "手机号"）。
   */
  function stripNoise(s) {
    let t = String(s);
    t = t.replace(/[（(][^）)]*[)）]/g, (m) => (NOISE.some((n) => m.includes(n)) ? "" : m));
    for (const n of NOISE) t = t.split(n).join("");
    t = t.replace(/^\s*(?:您的|你的|本人的|本人|自己的|确认|再次输入|重新输入|重复输入|请再次输入|请重新输入)+/, "");
    return t;
  }

  /** 归一化：全角转半角 → 剥提示词 → 去空白 → 小写 → 去标点 */
  function normalize(s) {
    if (s == null) return "";
    let t = toHalfWidth(s);
    t = stripNoise(t);
    t = t.replace(/\s+/g, "").toLowerCase();
    t = t.replace(PUNCT, "");
    return t.trim();
  }

  /**
   * Dice 系数（字符二元组）。
   * 对中文短标签（"毕业院校" vs "毕业学校"）比编辑距离更宽容，且不需要分词。
   * 返回 0~1。
   */
  function similarity(a, b) {
    const s1 = normalize(a);
    const s2 = normalize(b);
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1;
    if (s1.length < 2 || s2.length < 2) return 0;

    const grams = (s) => {
      const m = new Map();
      for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        m.set(g, (m.get(g) || 0) + 1);
      }
      return m;
    };
    const g1 = grams(s1);
    const g2 = grams(s2);
    let inter = 0;
    for (const [g, c] of g1) if (g2.has(g)) inter += Math.min(c, g2.get(g));
    return (2 * inter) / (s1.length - 1 + s2.length - 1);
  }

  /**
   * 取数字串（用于日期的「形态折叠」比较）。
   * 只认「以 4 位年份开头」的值，避免把「二级」这种数值型选项卷进来。
   * 返回 null 表示不是日期形态。
   */
  function dateNumerals(s) {
    const t = toHalfWidth(String(s)).trim();
    if (!/^\d{4}(\s*[年\-/.]|\s*$)/.test(t)) return null;
    const nums = (t.match(/\d+/g) || []).map(Number);
    return nums.length ? nums.slice(0, 3) : null;
  }

  /**
   * 组件显示的值与档案值是否算同一个东西（填充后读回校验用）。
   *
   * 比 normalize 宽松一档，因为组件展示的写法几乎不可能和档案里一模一样：
   *   「2003年6月」↔「2003-06」、「湖北 / 武汉」↔「湖北武汉」、「Java Python」↔「Java；Python」
   * 但绝不放宽到「随便什么都能过」—— 少了这个函数，读回校验会把
   * 「值其实没进去」误判成成功，那就又回到「假成功」的老路上了。
   */
  function sameValue(a, b) {
    const na = normalize(a);
    const nb = normalize(b);
    if (!na || !nb) return false;
    if (na === nb) return true;

    // 日期：按 [年, 月, 日] 比，短的一方是长的一方的前缀即可（dateYm 对完整日期）
    const da = dateNumerals(a);
    const db = dateNumerals(b);
    if (da && db) {
      const n = Math.min(da.length, db.length);
      let same = true;
      for (let i = 0; i < n; i++) if (da[i] !== db[i]) same = false;
      if (same) return true;
    }

    // 「湖北 / 武汉」这类带分隔符的显示值：去掉一切分隔后互为包含
    return false;
  }

  /**
   * 「组件显示的值」算不算已经把「档案里的值」填进去了（填充后读回校验）。
   *
   * 这里必须比 sameValue 严：级联组件点完第一级时显示值已经和目标值是前缀关系，
   * 但值其实只填了一半（点完「2003」还没点月）。松一档就会把半成品报成成功 ——
   * 那正是这个项目最想避免的「假成功」。
   * 允许的宽松只有一处：组件比档案更精确（档案 2003-06，组件显示 2003-06-01）。
   */
  function coversValue(displayed, target) {
    const na = normalize(displayed);
    const nb = normalize(target);
    if (!na || !nb) return false;
    if (na === nb) return true;

    const da = dateNumerals(displayed);
    const db = dateNumerals(target);
    if (da && db) {
      if (da.length < db.length) return false;
      for (let i = 0; i < db.length; i++) if (da[i] !== db[i]) return false;
      return true;
    }
    return false;
  }

  /** 数字写法等价：面板里写「6」，档案里写「06」 */
  function numEq(a, b) {
    const sa = String(a).trim();
    const sb = String(b).trim();
    if (!/^\d+$/.test(sa) || !/^\d+$/.test(sb)) return false;
    return Number(sa) === Number(sb);
  }

  /** 值的各个分量（用于多选：档案里「Java；Python」要在页面上分两次点） */
  const MULTI_SEP = /[；;、,，|/]+/;

  /**
   * 一个档案值在页面上可能被写成什么样 —— 下拉面板里要依次找的候选文本。
   *
   * 两档，默认只给「保守档」：
   *   · 保守档：原值 + 日期分量（2003-06 → 2003 / 6 / 06 / 6月）。日期必须拆，
   *     因为年月两级面板一次只能点一级。
   *   · cascade 档：再加「中文前缀」（河北保定 → 河北）与多选分量（Java；Python → Java / Python）。
   *     这两条都有代价：前缀可能把「深圳南山」点成「深圳」。所以只在保守档一个都没找到时才启用，
   *     且即便点中，填完的读回校验仍会因为它不等于目标值而报告成失败 —— 让用户看一眼，不替他做主。
   */
  function valueAttempts(target, opts) {
    const raw = toHalfWidth(String(target)).trim();
    if (!raw) return [];
    const out = [raw];

    if (/^\d{4}\s*[-/.]\s*\d{1,2}(\s*[-/.]\s*\d{1,2})?$/.test(raw)) {
      const [y, m, d] = raw.split(/\D+/).filter(Boolean);
      const pad = (x) => `0${Number(x)}`.slice(-2);
      out.push(y, `${y}年`, m, String(Number(m)), pad(m), `${Number(m)}月`);
      if (d) out.push(d, String(Number(d)), pad(d), `${Number(d)}日`);
    } else if (/^\d{4}$/.test(raw)) {
      out.push(`${raw}年`);
    }

    if (!opts || !opts.cascade) return [...new Set(out)].filter(Boolean);

    // 中文级联：只有「无分隔的纯中文长值」才敢拆前缀，否则「软件工程」会被拆成「软件」
    if (/^[\u4e00-\u9fa5]{4,}$/.test(raw)) {
      for (let n = 2; n <= Math.min(3, raw.length - 2); n++) out.push(raw.slice(0, n));
    }
    // 多选：拆成分量（放在最后，同分时长的写法优先）
    const parts = raw.split(MULTI_SEP).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1 && parts.length <= 4 && parts.every((p) => p.length <= 20)) {
      for (const p of parts) out.push(p);
    }

    return [...new Set(out)].filter(Boolean);
  }

  /** 从待选值里去掉已经选中过的那一段（多选与级联共用） */
  function dropAttempt(rest, attempt) {
    if (!attempt || !String(rest).includes(attempt)) return rest;
    return String(rest)
      .replace(attempt, "")
      .replace(/^[\s；;、,，|/\-—–]+|[\s；;、,，|/\-—–]+$/g, "");
  }

  const N = {
    normalize,
    stripNoise,
    toHalfWidth,
    similarity,
    sameValue,
    coversValue,
    numEq,
    valueAttempts,
    dropAttempt,
    dateNumerals,
    NOISE
  };

  RFA.N = N;
  RFA.normalize = N;
})();
