/**
 * 多段经历（DESIGN.md 7.8 / 7.10）。
 *
 * 网申页面初始通常只渲染 1 段经历，必须点「添加」才会出现第 2、3 段。不做这一步
 * 就只能填第一段，而「教育 + 实习 + 项目」逐段录入恰恰是网申最耗时间的地方。
 *
 * 这个模块解决四件事：
 *   1. detect()  — 把页面划成若干「区」，判定哪个区属于哪一类重复经历，并划出区内的段；
 *   2. ensure()  — 页面上段数少于档案时，点「添加」自动补齐；
 *   3. plan()    — 段作用域匹配：第 i 段只跟档案的第 i 段比对；
 *   4. 区层接管  — 判定为「另一类经历」或「重复区块」的区，整区交出控件、不参与全局匹配。
 *
 * 为什么必须做段作用域（本项目最危险的一类 bug）：
 *   用全局选择器按顺序取控件，会把第 2 段的公司名填进第 1 段，而且是**静默错填**，
 *   核对时未必看得出来。所以第 i 段一律限定在段内的候选控件上匹配，禁止全局索引取值。
 *
 * ---------------------------------------------------------------------------
 * v0.2.2 重构：不再靠类名猜「段容器」（实测踩坑，见 DESIGN.md 第 16 节）
 *
 * 旧实现按类名特征（item|card|exp…）从控件向上找段容器。这在自研页面上能跑，
 * 但真实 ATS（北森 / 智联 zhiye.com）用 styled-components，类名全是哈希
 * （`sc-iAKGXU` / `dyvPlo`），一个语义词都没有 —— 实测 62 个控件里 39 个找不到容器，
 * detect() 返回空，于是「段识别」整条链路静默失效：
 *   区块标题裁决不生效 → 段层接管不生效 → 退化成全局匹配；
 *   而 `maxOccurrence=1` 意味着同一个档案字段只认一个控件，于是
 *     「公司名称」（工作经历区）抢走 internships[].company，
 *     「单位名称」（实习经历区）反而无人认领 → 实习经历一片空白。
 *   报告还写着「已按段填入 2 段」—— 报告本身在骗人。
 *
 * 新实现换成两层模型，两层的判据都不看类名：
 *   区（scope）：由**标题**划出。标题之后、下一个同类标题之前的兄弟节点构成一个区。
 *                标题识别除常规标签外，还接受「裸文本 + 后面紧跟一个含 ≥3 控件的兄弟」
 *                —— 北森的区块标题就是 `<div class="sc-efQSVx">实习经历</div>` 这种写法。
 *   段（segment）：区内控件按**序号**切分 —— 遇到与区内首个控件同名标签的控件就开新段。
 *                段内字段标签天然重复，是最稳的信号，不需要任何 DOM 结构假设。
 *
 * 由此得到的判定优先级：区块标题 > 字段打分 > 结构假设。
 * 「工作经历」这类标题不在任何段的 segmentTitles 里，但在段的 excludeTitles 里 ——
 * 于是它会被显式排除（前提是页面上另有该段的专属区），而不是被字段打分拉去填实习数据。
 */
(function () {
  const RFA = globalThis.__RFA;

  /** 区块标题可能出现的元素 */
  const TITLE_SEL =
    "h1, h2, h3, h4, h5, h6, legend, summary, " +
    "[class*='title'], [class*='Title'], [class*='header'], [class*='Header'], " +
    "[class*='caption'], [class*='Caption'], [class*='heading']";

  /** 这些标签不可能是区块标题 */
  const NO_TITLE_TAG = /^(button|a|input|select|textarea|script|style|link|meta|iframe|svg|img|br|hr)$/i;

  /** 字段标签的类名特征：`form-item__title` 这类是单个字段的标签，不是区块标题 */
  const FIELD_LABEL_CLASS = /(form-?item|form-?row|field-?label|item-?label)/i;

  /** 「添加一段」按钮的文案 */
  const ADD_TEXT = /(添加|新增|增加|再加|继续添加|加一条|添\s*加)/;

  /** 纯图标「添加」按钮：只有一个加号字形 */
  const ADD_ICON = /^[+＋]$/;

  /**
   * 「添加」按钮的类名/id 特征。
   * 分段要求 add/plus/append 自成一段（裸 `add` 会误命中 `address`），
   * 同时容忍驼峰后缀 —— 北森的按钮 id 形如 `…-8d8d3vgt0v5_addButton`。
   */
  const ADD_CLASS = /(^|[-_\s])(add|plus|append)(btn|button|item|row|block|entry)?($|[-_\s])/i;

  /** 这些「添加」按钮加的是附件/照片之类，不是一段经历，排除掉 */
  const ADD_NOISE = /(附件|简历|文件|照片|图片|上传|证书|头像|链接)/;

  const MAX_ADD = 6; // 单次最多点几次「添加」，页面异常时不至于一直点
  const MAX_DEPTH = 20; // 收集标题时的祖先层数上限（北森控件到区块标题有 15 层）
  const TITLE_MAX_LEN = 24; // 超过这个长度就不像区块标题了（多半是整段说明文字）
  const MIN_SCOPE_CONTROLS = 2; // 只有 1 个控件的「区」是字段标签造成的噪音
  const BTN_SELECTOR = "button, a, [role='button'], input[type=button], span, div, i";

  function classOf(node) {
    return typeof (node && node.className) === "string" ? node.className : "";
  }

  function visible(node) {
    try {
      return node.getClientRects().length > 0;
    } catch (_) {
      return false;
    }
  }

  function docOrder(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function countControls(node) {
    try {
      return node.querySelectorAll("input, select, textarea").length;
    } catch (_) {
      return 0;
    }
  }

  const hasControlCache = new WeakMap();
  function hasControl(node) {
    if (!node || !node.querySelector) return false;
    if (hasControlCache.has(node)) return hasControlCache.get(node);
    let v = false;
    try {
      v = !!node.querySelector("input, select, textarea");
    } catch (_) {
      v = false;
    }
    hasControlCache.set(node, v);
    return v;
  }

  function matchesSafe(node, sel) {
    try {
      return !!(node.matches && node.matches(sel));
    } catch (_) {
      return false;
    }
  }

  /* ---------------- 标题 ---------------- */

  function titleTextOf(node) {
    if (!node) return "";
    const t = (node.textContent || "").replace(/\s+/g, " ").trim();
    return t.length >= 2 && t.length <= TITLE_MAX_LEN ? t : "";
  }

  /**
   * 是不是区块标题。
   *
   * 两条路径：
   *   a) 标签/类名明确（h2、legend、`.panel-title`）；
   *   b) 裸文本标题 —— 无控件、够短，且**后面紧跟一个含 ≥3 个控件的大块**。
   *      b 是为北森这类页面准备的：`<div class="sc-efQSVx">实习经历</div>` 后面跟着
   *      整个区块的内容，类名里没有任何语义词。
   */
  function isTitleLike(node) {
    if (!node || node.nodeType !== 1) return false;
    if (NO_TITLE_TAG.test(node.tagName)) return false;
    if (node.getAttribute && node.getAttribute("role") === "button") return false;

    const text = titleTextOf(node);
    if (!text) return false;
    if (ADD_TEXT.test(text)) return false; // 「添加实习经历」是按钮，不是标题
    if (hasControl(node)) return false; // 内部有控件的一定不是标题
    if (FIELD_LABEL_CLASS.test(classOf(node))) return false; // `.form-item__title` 是字段标签

    if (matchesSafe(node, TITLE_SEL)) return true;

    // 裸文本标题：必须紧跟一个像样的内容块，否则「姓名」这种字段标签也会被当成标题
    const next = node.nextElementSibling;
    return !!(next && hasControl(next) && countControls(next) >= 3);
  }

  /**
   * 收集页面上的区块标题。
   *
   * 不去遍历整棵 DOM（真实页面几万个节点），只走「控件的祖先链」——
   * 标题一定与内容块同级，所以它必然出现在某个控件祖先的子节点里。
   */
  function collectTitles(controls) {
    const pool = new Set();
    for (const c of controls) {
      let n = c.el.parentElement;
      for (let d = 0; n && d < MAX_DEPTH && n !== document.body; d++) {
        pool.add(n);
        n = n.parentElement;
      }
    }
    if (document.body) pool.add(document.body);

    const seen = new Set();
    const titles = [];
    for (const node of pool) {
      let kids;
      try {
        kids = node.children;
      } catch (_) {
        continue;
      }
      for (const child of kids) {
        if (seen.has(child)) continue;
        seen.add(child);
        if (isTitleLike(child)) titles.push(child);
      }
    }
    titles.sort(docOrder);
    return titles;
  }

  /**
   * 标题 → 语义段。**只认唯一命中**：像「工作/实习经历」这种同时挂到两个段的标题，
   * 判定不唯一，返回 null 交回字段打分去兜底。
   */
  function matchSectionByTitle(title, dict) {
    const t = RFA.N.normalize(title || "");
    if (!t) return null;
    const hits = new Map();
    for (const sec of dict.sections) {
      const kws = sec.segmentTitles;
      if (!Array.isArray(kws) || !kws.length) continue;
      for (const kw of kws) {
        const k = RFA.N.normalize(kw);
        if (!k) continue;
        // 短标题要求整段相等；长标题允许包含（「实习经历（必填）」「请添加教育经历」）
        if (t === k || (k.length >= 4 && t.includes(k))) {
          hits.set(sec.id, sec);
          break;
        }
      }
    }
    return hits.size === 1 ? Array.from(hits.values())[0] : null;
  }

  /**
   * 标题 → 它**明确不属于**的那些段（数据驱动，schema 里的 excludeTitles）。
   *
   * 用途：页面同时有「工作经历」和「实习经历」两个区块、档案里只有实习时，
   * 光靠字段打分两边都是满分；靠这里的互斥声明才能把「工作经历」整块排除。
   */
  function matchExcludeTitles(title, dict) {
    const out = new Set();
    const t = RFA.N.normalize(title || "");
    if (!t) return out;
    for (const sec of dict.sections) {
      const kws = sec.excludeTitles;
      if (!Array.isArray(kws) || !kws.length) continue;
      for (const kw of kws) {
        const k = RFA.N.normalize(kw);
        if (!k) continue;
        if (t === k || (k.length >= 4 && t.includes(k))) {
          out.add(sec.id);
          break;
        }
      }
    }
    return out;
  }

  /**
   * 这个区的标题是不是「整块不填」的区块（家庭情况 / 紧急联系人…）。
   *
   * 家属的「姓名」「工作单位」和求职者自己的字段完全同名同形，`maxOccurrence` 也挡不住
   * 后者 —— 实测「工作单位」被填成了自己的实习公司。这类区块只能按标题整块跳过。
   */
  function matchSkipTitles(title, dict) {
    const t = RFA.N.normalize(title || "");
    if (!t) return false;
    for (const kw of dict.skipSections || []) {
      const k = RFA.N.normalize(kw);
      if (!k) continue;
      if (t === k || (k.length >= 2 && t.includes(k))) return true;
    }
    return false;
  }

  /* ---------------- 「添加」按钮 ---------------- */

  function isAddButton(node) {
    if (!node) return false;
    if (RFA.isOwnUI(node)) return false;

    const t = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (t && ADD_NOISE.test(t)) return false;
    if (ADD_ICON.test(t)) return true;
    if (t && t.length <= 20 && ADD_TEXT.test(t)) return true;

    const sig = classOf(node) + " " + (node.id || "");
    if (!ADD_CLASS.test(sig)) return false;
    if (!t) return true; // 纯图标按钮，靠类名/id 认出（北森的 `…_addButton`）
    return t.length <= 12 && node.tagName === "BUTTON"; // 短文案 + 真按钮
  }

  function isRealButton(n) {
    if (!n) return false;
    const tag = n.tagName;
    if (tag === "BUTTON" || tag === "A") return true;
    if (n.getAttribute && n.getAttribute("role") === "button") return true;
    return (n.type || "").toLowerCase() === "button";
  }

  /** 在一组节点范围内找「添加」按钮 */
  function addButtonsIn(nodes) {
    const raw = [];
    const seen = new Set();
    for (const n of nodes || []) {
      let all;
      try {
        all = [n].concat(Array.from(n.querySelectorAll(BTN_SELECTOR)));
      } catch (_) {
        continue;
      }
      for (const b of all) {
        if (seen.has(b)) continue;
        seen.add(b);
        if (!visible(b)) continue;
        if (isAddButton(b)) raw.push(b);
      }
    }
    // 按钮的文案会被内层 div/span 继承，同一个按钮会命中多次。
    // 页面上有真按钮时只认真按钮（真按钮外面那层外壳点了不会触发）；
    // 全是 div 时（北森）保留最外层那个承载点击事件的容器。
    const real = raw.filter(isRealButton);
    const pool = real.length ? real : raw;
    return pool.filter((b) => !pool.some((o) => o !== b && o.contains(b)));
  }

  /**
   * 该区的「添加」按钮。
   * 先在区内找；区外只认「紧跟在本区之后的兄弟」，不扫整个父容器 ——
   * 否则会先把隔壁区的按钮拿去点，白白给它加出一段（实测有些站点点错了就真会加）。
   */
  function addButtonsFor(scope) {
    const list = addButtonsIn(scope.nodes);
    const last = scope.nodes[scope.nodes.length - 1];
    let sib = last && last.nextElementSibling;
    for (let hop = 0; sib && hop < 3; sib = sib.nextElementSibling, hop++) {
      if (isAddButton(sib) && !list.includes(sib)) list.push(sib);
    }

    // 文案与本区标题对得上的排前面（「添加实习经历」之于「实习经历」），
    // 剩下靠「点完段数必须变多」兜底 —— 猜错没有代价，只是多试一次。
    const t = RFA.N.normalize(scope.title || "");
    const rank = (b) => {
      if (!t) return 1;
      const bt = RFA.N.normalize((b.textContent || "").trim());
      return bt && (bt.includes(t) || t.includes(bt)) ? 0 : 1;
    };
    if (t) list.sort((a, b) => rank(a) - rank(b));
    return list;
  }

  /* ---------------- 区 ---------------- */

  /**
   * 划区：标题 + 「标题之后、下一个同类标题之前」的兄弟节点。
   *
   * 「下一个标题」不一定是兄弟本身，也可能嵌在某个兄弟里面
   * （`<div class="other"><h2>其他信息</h2>…` 这种包装），所以遇到「内部含标题的兄弟」
   * 也要在它之前停下 —— 否则前一个区会把后面那个区的控件一起吞掉，
   * 实测表现为「实习经历」区把「其他信息」的 3 个控件也算了进来，段划分随之错乱。
   *
   * 另一条边界规则：**区里已经拿到内容块（≥2 个控件的兄弟）之后，再出现「只有 1 个控件的
   * 行」就说明区块到此为止**。页面上区块末尾后面常常还跟着几个不带标题的独立字段行
   * （实测 work-vs-intern 的「联系电话」行紧跟在「实习经历」区块之后），
   * 不拦的话它会被算进实习段里、匹配不上任何实习字段，于是既填不上、又被排除在全局匹配之外
   * —— 表现为「手机号明明在页面上，却怎么都不填」。
   *
   * 反过来，区块从头到尾都是「一行一个字段」的布局（fieldset 里的 `.row`）时不会误停：
   * 那时内容块标记一直是 false，所有行照常收进来。
   *
   * @returns {Array} 每项 { titleEl, parent, nodes, title, controls }
   */
  function buildScopes(titles, candidates) {
    const titleSet = new Set(titles);
    const containsTitle = (node) => titles.some((t) => t !== node && node.contains(t));
    const raw = [];

    for (const t of titles) {
      const parent = t.parentElement;
      if (!parent) continue;
      const sibs = Array.from(parent.children);
      const i = sibs.indexOf(t);
      if (i < 0) continue;

      const nodes = [t];
      let contentSeen = false;
      for (let k = i + 1; k < sibs.length; k++) {
        const sib = sibs[k];
        if (titleSet.has(sib) || containsTitle(sib)) break;
        const n = countControls(sib);
        if (contentSeen && n === 1) break;
        nodes.push(sib);
        if (n >= 2) contentSeen = true;
      }

      const controls = candidates.filter((c) => c.kind !== "file" && nodes.some((n) => n.contains(c.el)));
      if (controls.length < MIN_SCOPE_CONTROLS) continue;
      raw.push({ titleEl: t, parent, nodes, title: titleTextOf(t), controls });
    }

    // 嵌套的区（区块标题 vs 区块里的字段标签）：控件多的优先，与已接受的区有重叠就丢弃
    raw.sort((a, b) => b.controls.length - a.controls.length);
    const taken = new Set();
    const out = [];
    for (const s of raw) {
      if (s.controls.some((c) => taken.has(c.idx))) continue;
      s.controls.forEach((c) => taken.add(c.idx));
      out.push(s);
    }

    out.sort((a, b) => docOrder(a.titleEl, b.titleEl));
    for (const s of out) s.addButtons = addButtonsFor(s);
    return out;
  }

  /* ---------------- 段划分 ---------------- */

  /**
   * 候选控件最可信的标签（归一化后）。
   *
   * 直接取 `ctx[0]` —— 排序由 `scan.js` 的 CTX_PRIORITY 统一负责。这里**不要**另起一套
   * 权重判断：match.js 的 SOURCE_WEIGHT 没有给 `sibling-label` 设权重，未列出的来源会走
   * 「默认 1」的兜底，反而盖过 `prev-sibling`，实测把区块小标题「教育经历 1」当成了
   * 段划分依据，把一整个区块错切成 4 段。
   */
  function labelKeyOf(cand) {
    const first = (cand.ctx || []).find((c) => c.norm);
    return first ? first.norm : "";
  }

  /**
   * 把区内的控件按「段」切开。
   *
   * 判据：段内第一个字段的标签会随段重复出现 —— 第 2 段的第一个控件，标签必然和
   * 第 1 段的第一个控件一样。这个信号不依赖类名、不依赖结构，对列表式和卡片式都成立。
   */
  function splitSegments(controls) {
    const list = controls || [];
    if (!list.length) return [];

    let head = "";
    for (let i = 0; i < Math.min(list.length, 3) && !head; i++) head = labelKeyOf(list[i]);
    if (!head) return [list]; // 连首个字段都认不出标签：不冒险切分，整区当一段

    const segs = [];
    let cur = [];
    let seenHead = 0;
    for (const c of list) {
      if (labelKeyOf(c) === head) {
        if (seenHead >= 1) {
          segs.push(cur);
          cur = [];
        }
        seenHead++;
      }
      cur.push(c);
    }
    if (cur.length) segs.push(cur);
    return segs.filter((s) => s.length);
  }

  /* ---------------- 段语义判定 ---------------- */

  /** 段的数组名：educations[].school → educations（注意 section.id 是 education，不能用它） */
  function arrayKeyOf(section) {
    const key = section.fields && section.fields[0] && section.fields[0].key;
    return key && key.includes("[].") ? key.split("[].")[0] : null;
  }

  /**
   * 判定这组控件属于哪个重复段：逐字段打分，取总分最高的一组。
   *
   * 质量门槛（hits >= 2 且有一个高置信命中）是必需的：只靠一次模糊命中就认定
   * 「这是个重复段」，会把「家庭情况」区里的「工作单位」这种偶合词当成实习经历 ——
   * 一旦误判，整个区会被区层接管控件，那些字段就再也填不上了（实测踩过）。
   */
  function resolveSection(controls, dict) {
    if (!controls || !controls.length) return null;
    let best = null;

    for (const sec of dict.sections) {
      if (!sec.repeatable) continue;
      const hitFields = new Set();
      let score = 0;
      let maxScore = 0;

      for (const cand of controls) {
        for (const field of sec.fields) {
          if (!RFA.match.typeCompat(cand.kind, field.type)) continue;
          const { score: s } = RFA.match.scoreCandidate(cand, field);
          if (s < 60) continue;
          if (field.sensitive && s < 100) continue;
          score += s;
          if (s > maxScore) maxScore = s;
          hitFields.add(field.key);
        }
      }

      if (hitFields.size < 2 || maxScore < 85) continue;
      if (!best || score > best.score) best = { section: sec, score, hits: hitFields.size };
    }

    return best ? best.section : null;
  }

  /**
   * 识别页面上的区。
   * @returns {{groups: Array, excluded: Array, scopes: Array}}
   *   groups   要按段填的区（含 { title, nodes, controls, section, arrayKey, addButtons, authoritative }）
   *   excluded 判定为「另一类经历」或「重复区块」的区；它们的控件必须由区层接管，不能落回全局匹配
   */
  function detect(candidates, dict) {
    const controls = candidates.filter((c) => c.kind !== "file");
    const scopes = buildScopes(collectTitles(controls), candidates);

    // 页面上哪些语义段已经有「自己带标题的区」——用来判断某个区是不是另一类经历
    const titledIds = new Set();
    for (const s of scopes) {
      s.byTitle = matchSectionByTitle(s.title, dict);
      if (s.byTitle) titledIds.add(s.byTitle.id);
    }

    const resolved = [];
    const excluded = [];

    for (const s of scopes) {
      // 「整块不填」的区块（家庭情况 / 紧急联系人…）优先判定：
      // 里面的字段与求职者本人同形，填了就是张冠李戴
      if (matchSkipTitles(s.title, dict)) {
        s.section = null;
        s.authoritative = false;
        s.why = "skip-section";
        excluded.push(s);
        continue;
      }

      if (s.byTitle) {
        // 标题只说明「这是什么」，不说明「它可以重复几段」。
        // 页面上单段的「教育经历」fieldset、「教育经历」卡片都属于这一类：字段语义明确，
        // 但页面根本没有第二段的入口。这时把整区接管过来只会把它后面的独立字段行一起吞掉
        // （划区再准也挡不住「区块与尾部字段同层」的写法），而这些字段本来就该走全局匹配。
        // 所以「可重复」必须有正面证据：附近有「添加」按钮，或者区内字段序列已经在重复。
        const segments = splitSegments(s.controls);
        if (!(s.addButtons || []).length && segments.length <= 1) continue;

        s.section = s.byTitle;
        s.authoritative = true;
        resolved.push(s);
        continue;
      }

      const byScore = resolveSection(s.controls, dict);
      const blockedLive = Array.from(matchExcludeTitles(s.title, dict)).filter((id) => titledIds.has(id));

      // 「另一类经历」优先判定，且**不看「可重复」证据**：
      // 它的危害是「把数据填错位置」，只要字段同形就必须整块拦住，
      // 否则「工作经历」区的控件会落回全局匹配，把实习数据抢过去（原始缺陷现场）。
      if (byScore && blockedLive.includes(byScore.id)) {
        s.section = byScore;
        s.authoritative = false;
        s.why = "other-section";
        excluded.push(s);
        continue;
      }
      if (!byScore && blockedLive.length) {
        s.section = dict.sections.find((x) => x.id === blockedLive[0]) || null;
        s.authoritative = false;
        s.why = "other-section";
        excluded.push(s);
        continue;
      }
      if (!byScore) continue; // 普通字段区（个人信息 / 求职意向…），控件交回全局匹配

      // 没有标题背书时，必须看到「这东西是可重复的」的证据，否则不认它是重复段。
      // 证据二选一：① 附近有「添加一段」按钮；② 区内的字段标签序列已经在重复（≥2 段）。
      // 少了这条，「求职意向」这种字段碰巧和实习字段同形的普通区块会被当成重复段，
      // 整个区的控件被接管 —— 区里那些本该正常填的字段就再也填不上了（实测踩过）。
      const segments = splitSegments(s.controls);
      if (!(s.addButtons || []).length && segments.length <= 1) continue;

      s.section = byScore;
      s.authoritative = false;
      resolved.push(s);
    }

    // 同一语义段只留一个区：优先「标题明确」的，其次控件多的。
    // 不裁决的话，留下哪一组取决于 DOM 遍历顺序 —— 这正是把实习填进工作经历的直接原因。
    const ordered = resolved
      .slice()
      .sort((a, b) => (b.authoritative ? 1 : 0) - (a.authoritative ? 1 : 0) || b.controls.length - a.controls.length);
    const bySection = new Map();
    for (const g of ordered) if (!bySection.has(g.section.id)) bySection.set(g.section.id, g);
    // 被裁决掉的区也要接管控件，否则它会落回全局匹配去抢别的字段
    for (const g of ordered) {
      if (bySection.get(g.section.id) !== g) {
        const kept = bySection.get(g.section.id);
        g.why = "duplicate-kept-other";
        g.keptTitle = kept.title;
        excluded.push(g);
      }
    }

    const groups = Array.from(bySection.values());
    for (const g of groups) {
      g.arrayKey = arrayKeyOf(g.section);
      g.segments = splitSegments(g.controls);
    }
    return { groups, excluded, scopes };
  }

  /* ---------------- 补齐段数 ---------------- */

  /**
   * 点「添加」补齐段数。
   * 每个候选按钮都点一次并**确认本区的控件数真的变多**，确认失败就换下一个候选。
   * 这一步是安全的：验证只看本区，点错隔壁区的按钮不会污染任何判断。
   */
  async function clickAdd(scope, times) {
    const countIn = () => scope.nodes.reduce((n, node) => n + countControls(node), 0);
    let added = 0;

    for (let i = 0; i < times; i++) {
      const before = countIn();
      let worked = false;
      for (const btn of scope.addButtons || []) {
        if (!btn.isConnected || !visible(btn)) continue;
        await RFA.fill.realClick(btn);

        const now = await RFA.waitFor(() => {
          const n = countIn();
          return n > before ? n : null;
        }, { timeout: 1600, interval: 100 });

        if (now) {
          worked = true;
          added++;
          break;
        }
      }
      if (!worked) break;
      await RFA.nextFrame();
    }
    return added;
  }

  /**
   * 补齐段数。必须在重新扫描之前调用（新段里的控件要重新进候选列表）。
   * @returns {{groups: Array, added: number, missing: Array, excluded: Array}}
   */
  async function ensure(candidates, dict, profile) {
    const det = detect(candidates, dict);
    let added = 0;
    const missing = [];

    for (const g of det.groups) {
      const rows = Array.isArray(profile[g.arrayKey]) ? profile[g.arrayKey] : [];
      const need = rows.length;
      const have = g.segments.length;
      if (!need || need <= have) continue;

      const n = await clickAdd(g, Math.min(need - have, MAX_ADD));
      added += n;

      if (have + n < need) {
        missing.push({
          section: g.section.label,
          have: have + n,
          need,
          reason: (g.addButtons || []).length ? "点「添加」没有生成新的一段" : "没找到「添加」按钮"
        });
      }
    }

    return { groups: det.groups, added, missing, excluded: det.excluded };
  }

  /**
   * 段作用域匹配计划。
   * @returns {{pairs, unmatched, ignored, scopedIdx, groups, excluded}}
   *   scopedIdx 是已被区层接管的下标集合 —— 区外的全局匹配必须排除它们，
   *   否则同一批控件会被匹配两次（这是防串段的另一半）。
   *   注意 excluded 里的区同样要进 scopedIdx（虽然不填），否则它们的控件会落回
   *   全局匹配去抢别的字段，实测会把「实习数据」填进「工作经历」区。
   */
  function plan(candidates, dict, profile) {
    const det = detect(candidates, dict);
    const pairs = [];
    const unmatched = [];
    const ignored = [];
    const scopedIdx = new Set();

    for (const g of det.groups) {
      const rows = Array.isArray(profile[g.arrayKey]) ? profile[g.arrayKey] : [];
      g.filledBlocks = 0;

      g.segments.forEach((segCands, i) => {
        segCands.forEach((c) => scopedIdx.add(c.idx));

        // 档案里没有这一段：整段跳过。页面常自带一个空段，标红只会制造噪音
        if (i >= rows.length) return;

        const m = RFA.match.matchAll(segCands, dict, profile, { fields: g.section.fields, arrayIndex: i });
        for (const p of m.pairs) {
          p.segment = `${g.section.label} §${i + 1}`;
          p.segmentIndex = i;
          pairs.push(p);
        }
        m.ignored.forEach((c) => ignored.push(c));
        m.unmatched.forEach((c) => unmatched.push(c));
        g.filledBlocks++;
      });
    }

    // 被判定为「另一类经历」/「重复区块」的区：整区接管、不填，列进未识别，给用户手动兜底的机会
    for (const g of det.excluded || []) {
      for (const c of g.controls) {
        scopedIdx.add(c.idx);
        unmatched.push(c);
      }
    }

    pairs.sort((a, b) => a.cand.idx - b.cand.idx);
    return { pairs, unmatched, ignored, scopedIdx, groups: det.groups, excluded: det.excluded };
  }

  /** 控件落在哪一段（手动指定字段时，用它决定取档案里的第几段值） */
  function segmentIndexOf(el, groups) {
    if (!el) return null;
    for (const g of groups || []) {
      const segs = g.segments || [];
      for (let i = 0; i < segs.length; i++) {
        if (segs[i].some((c) => c.el === el || (c.el.contains && c.el.contains(el)))) {
          return { arrayKey: g.arrayKey, index: i };
        }
      }
    }
    return null;
  }

  RFA.repeatable = {
    detect,
    ensure,
    plan,
    segmentIndexOf,
    arrayKeyOf,
    labelKeyOf,
    splitSegments,
    resolveSection,
    collectTitles,
    buildScopes,
    addButtonsFor,
    matchSectionByTitle,
    matchExcludeTitles,
    matchSkipTitles
  };
})();
