/**
 * 表单扫描：把页面上所有可填控件变成结构化候选，供匹配引擎使用。
 *
 * 这是整个扩展的输入层。它只做「观察」，绝不修改页面。
 * 上下文收集的完整度直接决定 L2 的命中率（DESIGN.md 6.1）。
 */
(function () {
  const RFA = globalThis.__RFA;
  const N = RFA.N;

  /** 自定义下拉/日期组件的特征类名，命中即按 combobox 处理 */
  const COMBO_HINT_SELECTOR = [
    ".ant-select",
    ".ant-picker",
    ".el-select",
    ".el-date-editor",
    '[class*="mx-select"]',
    '[class*="mx-date"]',
    '[role="combobox"]',
    '[aria-haspopup="listbox"]',
    '[aria-haspopup="menu"]',
    '[aria-haspopup="true"]'
  ].join(",");

  /** 表单行容器：它内部的文本往往是最准确的字段标签 */
  const FORM_ITEM_SELECTOR = [
    ".ant-form-item",
    ".el-form-item",
    '[class*="form-item"]',
    '[class*="formItem"]',
    ".form-group",
    "td",
    "dd",
    "li"
  ].join(",");

  /**
   * BEM 子部件不是「字段行」本身。
   *
   * 实测踩坑（北森）：字段行的类名是 `.form-item.form-item--phoenix`，而它内部还有
   * `.form-item__control`（控件容器）和 `.form-item__title`（标签容器）。三者都能命中
   * `[class*="form-item"]`，`closest()` 会先返回**最靠里的** `.form-item__control` ——
   * 那里没有 label，于是所有日期下拉的标签全部取不到，报告里显示成「第 38 个控件」。
   * BEM 的 `__` 是子元素、`--` 是修饰符，所以只排除 `__`。
   */
  const BEM_PART = /(form-?item|form-?row)__/i;

  /**
   * 不是字段标签的文本：字数统计（`506/2000`）、必填星号（`*`）、纯符号等。
   * 组件库的 textarea 下方常带一个计数器，它作为「前兄弟」在 DOM 里排在真标签前面，
   * 不排除就会把标签覆盖掉（实测：工作职责的标签显示成 `506/2000`）。
   */
  const NOISE_TEXT = /^[\d\s/\-+.,:;：；%*＊·()（）\[\]【】]+$/;

  /**
   * 上下文来源的展示优先级：数字越小越像「这个字段的标签」。
   * 只用于「选一条给人看 / 选一条当段划分依据」，不参与打分。
   */
  const CTX_PRIORITY = {
    "label-for": 1,
    "aria-label": 1,
    "aria-labelledby": 1,
    "form-item-label": 1,
    "label-wrap": 2,
    "table-cell": 3,
    "form-item": 4,
    placeholder: 5,
    "prev-sibling": 6,
    ancestor: 7,
    title: 8,
    name: 9,
    id: 10,
    "sibling-label": 11
  };

  const ctxRank = (src) => (CTX_PRIORITY[src] == null ? 50 : CTX_PRIORITY[src]);

  function classOf(node) {
    return typeof (node && node.className) === "string" ? node.className : "";
  }

  /**
   * 「影子输入框」识别 —— 组件库下拉/日期组件内部那个 input 不是真输入框。
   *
   * 实测（北森智联 zhiye.com 校招门户，fixtures/beisen-portal.html 就是它的快照）：
   *   <div class="phoenix-select phoenix-select--editable">
   *     <div class="phoenix-select__placeHolder ...phoenix-select__placeHolder--show">请选择</div>
   *     <ul class="phoenix-select__content">
   *       <li class="phoenix-select__inputWrapper"><input class="phoenix-select__input" value=""></li>
   *     </ul>
   *     <div class="phoenix-select__switchArrow">…</div>
   *   </div>
   * 那个 input **既没有 readonly 也没有 role=combobox**，值也不由它承载（真正的展示层是
   * placeHolder / content）。按「普通文本框」处理的话，fillText 会把值写进这个组件根本不读的
   * input 里 —— 读回 `el.value` 还是对的，于是报告说「已填入」，页面上却依旧显示「请选择」。
   * 这就是最典型的「假成功」，比填错更难发现。
   *
   * 判据不看单个类名，而是「类名里带 select/picker 这类词的元素 *且* 它具备下拉的形态特征」
   * （内含 ul/li、箭头、占位层或已选项），避免把 `class="select-all"` 这种普通输入框误伤。
   */
  const COMBO_TOKEN_SPLIT = /[\s_-]+/;
  const COMBO_TOKEN = /(select|picker|cascader|combobox|autocomplete|tree-?select|dropdown|chooser)/i;
  const COMBO_AFFORDANCE = [
    "ul",
    "li",
    "[class*='arrow' i]",
    "[class*='caret' i]",
    "[class*='suffix' i]",
    "[class*='placeHolder' i]",
    "[class*='placeholder' i]",
    "[class*='selection' i]",
    "[class*='selected' i]"
  ].join(",");

  function comboTokenIn(cls) {
    const s = typeof cls === "string" ? cls : "";
    if (!s) return false;
    return s.split(COMBO_TOKEN_SPLIT).some((t) => t && COMBO_TOKEN.test(t));
  }

  /**
   * 控件所在的「下拉组件」容器（最外层的那个，accent 由它承载点击）。
   * 返回 null 表示这就是个普通输入框。
   */
  function comboWrapperOf(el, limit = 4) {
    if (!el || el.tagName !== "INPUT") return null;
    let found = null;
    let node = el.parentElement;
    for (let d = 0; node && d < limit && node !== document.body; d++) {
      if (comboTokenIn(classOf(node)) && node.querySelector(COMBO_AFFORDANCE)) found = node;
      node = node.parentElement;
    }
    return found;
  }

  function classify(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (tag !== "input") return null;

    const t = (el.type || "text").toLowerCase();
    // 这些一律不填：隐藏域、按钮、密码
    if (["hidden", "submit", "button", "reset", "image", "password"].includes(t)) return null;
    if (t === "file") return "file";
    if (t === "radio") return "radio";
    if (t === "checkbox") return "checkbox";
    if (t === "date") return "date";
    if (t === "number") return "number";
    if (t === "email") return "email";
    if (t === "tel") return "tel";
    if (t === "url") return "url";

    // 只读输入框基本是组件库的下拉/日期触发器，需要「点开再选」而不是直接赋值
    if (el.readOnly) return "combobox";
    if (el.closest(COMBO_HINT_SELECTOR) && el.getAttribute("role") === "combobox") return "combobox";
    // 最后一道：能识别出下拉容器（值不由 input 承载）的也是下拉
    if (comboWrapperOf(el)) return "combobox";
    return "text";
  }

  /** 收集所有控件，并穿透 shadow DOM */
  function collectControls(root) {
    const out = [];

    function visit(node) {
      let list;
      try {
        list = node.querySelectorAll("input, textarea, select");
      } catch (_) {
        return;
      }
      list.forEach((el) => {
        if (!RFA.isOwnUI(el)) out.push(el);
      });

      // 穿透 shadow root：querySelectorAll 不会跨越 shadow 边界
      try {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
        const hosts = [];
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (el.shadowRoot) hosts.push(el.shadowRoot);
        }
        hosts.forEach(visit);
      } catch (_) {
        /* ignore */
      }
    }

    visit(root);
    return out;
  }

  /** 控件的自身文本标签（单选框/复选框的选项名就靠它） */
  function ownLabel(el) {
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel && forLabel.textContent.trim()) return forLabel.textContent.trim();
    }
    const wrap = el.closest("label");
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();

    // 相邻的文本节点/兄弟元素
    let sib = el.nextElementSibling;
    if (sib && sib.tagName !== "INPUT" && sib.textContent.trim()) return sib.textContent.trim();
    const parent = el.parentElement;
    if (parent) {
      const t = Array.from(parent.childNodes)
        .filter((n) => n.nodeType === 3 || n.tagName === "SPAN" || n.tagName === "LABEL" || n.tagName === "DIV")
        .map((n) => n.textContent.trim())
        .join(" ")
        .trim();
      if (t) return t;
    }
    return el.value || el.getAttribute("value") || "";
  }

  /**
   * 祖先链上所有「像字段行」的节点，从近到远。
   *
   * 之所以返回一串而不是一个：组件库常见的写法是「字段行 > 标签容器 + 控件容器」，
   * 控件容器本身也命中选择器但没有标签，必须继续往上找才拿得到标签。
   */
  function formItemChain(el, limit = 12) {
    const out = [];
    let node = el.parentElement;
    for (let d = 0; node && d < limit && node !== document.body; d++) {
      let hit = false;
      try {
        hit = node.matches(FORM_ITEM_SELECTOR);
      } catch (_) {
        hit = false;
      }
      if (hit && !BEM_PART.test(classOf(node))) out.push(node);
      node = node.parentElement;
    }
    return out;
  }

  /** 找所属的表单行容器（跳过 BEM 子部件） */
  function findFormItem(el) {
    const chain = formItemChain(el, 8);
    return chain.length ? chain[0] : null;
  }

  /**
   * 收集字段的上下文文本片段。
   * 顺序即优先级：越靠前的来源越像"这个字段的标签"。
   */
  function collectContext(el) {
    const out = [];
    const seen = new Set();

    const push = (text, src) => {
      if (text == null) return;
      let t = String(text).replace(/\s+/g, " ").trim();
      if (!t || t.length > 60) return;
      if (NOISE_TEXT.test(t)) return; // 字数统计、必填星号之类
      const n = N.normalize(t);
      if (!n || seen.has(n)) return;
      seen.add(n);
      out.push({ text: t, norm: n, src });
    };

    // 1. label[for=id]
    if (el.id) {
      document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`).forEach((l) => push(l.textContent, "label-for"));
    }
    // 2. aria
    push(el.getAttribute("aria-label"), "aria-label");
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach((id) => {
        const node = document.getElementById(id);
        if (node) push(node.textContent, "aria-labelledby");
      });
    }
    // 3. placeholder / title
    push(el.getAttribute("placeholder"), "placeholder");
    push(el.getAttribute("title"), "title");
    // 4. name / id（拼音缩写也有用：xingming / shouji）
    push(el.getAttribute("name"), "name");
    push(el.id, "id");

    // 5. 包裹式 label
    let node = el.parentElement;
    for (let hop = 0; node && hop < 4; hop++) {
      if (node.tagName === "LABEL") {
        push(node.textContent, "label-wrap");
        break;
      }
      node = node.parentElement;
    }

    // 6. 表单行容器的标签（组件库场景下最准的来源）
    //    从最近的一层往上试，谁先给出有效标签就用谁 —— 一行里的控件容器通常是空的，
    //    真正的标签在它的外层（`.form-item__title > label`）。
    for (const formItem of formItemChain(el)) {
      if (formItem.tagName === "TD") continue;
      const before = out.length;
      const labelEl = formItem.querySelector("label, .ant-form-item-label, .el-form-item__label, [class*='label']");
      if (labelEl) push(labelEl.textContent, "form-item-label");
      else push(formItem.textContent, "form-item");
      if (out.length > before) break;
    }

    // 7. table 布局（银行/央国企自研系统常见）：取同一个 tr 里它前面的单元格
    const tr = el.closest("tr");
    if (tr) {
      const tds = Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
      const selfTd = el.closest("td");
      const i = tds.indexOf(selfTd);
      for (let k = i - 1; k >= 0 && k >= i - 2; k--) {
        if (tds[k] && !tds[k].querySelector("input, select, textarea")) {
          push(tds[k].textContent, "table-cell");
          break;
        }
      }
    }

    // 8. 前面的兄弟元素文本
    let sib = el.previousElementSibling;
    for (let hop = 0; sib && hop < 3; hop++) {
      if (!/^(input|select|textarea|button)$/i.test(sib.tagName)) {
        const t = (sib.textContent || "").trim();
        if (t) {
          push(t, "prev-sibling");
          break;
        }
      }
      sib = sib.previousElementSibling;
    }

    // 9. 向上最多 5 层的祖先里，找"看起来像标签"的文本
    node = el.parentElement;
    for (let depth = 0; node && depth < 5 && node !== document.body; depth++) {
      const t = ownShortText(node);
      if (t) push(t, "ancestor");

      // 组件库常把标签放在兄弟节点上：
      //   <div class="field"><span class="lb">最高学历</span><div class="el-select">…</div></div>
      // 这时祖先链上只有元素没有裸文本，靠这一步才能捞到标签。
      //
      // 但必须排除「内部还有别的控件」的兄弟节点 —— 否则向上走到 fieldset 这一层时，
      // 会把相邻字段的标签也当成自己的上下文，造成串字段的错填（实测踩过）。
      for (const child of node.children) {
        if (child.contains(el)) continue;
        if (child.querySelector("input, select, textarea")) continue;
        if (/^(input|select|textarea|button|form|table|ul|ol|script|style)$/i.test(child.tagName)) continue;
        const ct = (child.textContent || "").trim();
        if (ct && ct.length >= 2 && ct.length <= 20) push(ct, "sibling-label");
      }

      node = node.parentElement;
    }

    // 按「像不像这个字段的标签」排序。
    //
    // 不能借用 match.js 的 SOURCE_WEIGHT：那张表里没有 `sibling-label`，
    // 未列出的来源会走「默认权重 1」的兜底，反而排到最前面 —— 实测把区块小标题
    // 「教育经历 1」顶到了真标签「毕业院校」前面，进而让段划分把一整个区块错切成 4 段。
    // 这里用一张只服务于「展示与取标签」的显式优先级表，低于 50 的来源排最后。
    out.sort((a, b) => ctxRank(a.src) - ctxRank(b.src)); // 稳定排序：同级别保持收集顺序

    return out;
  }

  /** 取节点自身的短文本（不含子控件内的文字） */
  function ownShortText(node) {
    if (!node || !node.childNodes) return "";
    for (const child of node.childNodes) {
      if (child.nodeType !== 3) continue;
      const t = (child.nodeValue || "").trim();
      if (t && t.length >= 2 && t.length <= 30) return t;
    }
    return "";
  }

  /** 是否必填：属性 + 上下文里的 * 或「必填」 */
  function isRequired(el, ctx) {
    if (el.required) return true;
    if (el.getAttribute("aria-required") === "true") return true;
    const joined = ctx.map((c) => c.text).join(" ");
    if (/[*＊]/.test(joined)) return true;
    if (joined.includes("必填")) return true;
    const formItem = findFormItem(el);
    if (formItem) {
      const cls = classOf(formItem);
      if (cls && /required|is-required/i.test(cls)) return true;
      const req = formItem.querySelector(".ant-form-item-required, .el-form-item__label.is-required, [class*='required']");
      if (req) return true;
      const text = (formItem.textContent || "").slice(0, 100);
      if (/[*＊]/.test(text)) return true;
    }
    return false;
  }

  function collectOptions(el, kind) {
    if (kind === "select") {
      return Array.from(el.options || []).map((o) => ({
        text: (o.textContent || "").trim(),
        value: o.value
      }));
    }
    return [];
  }

  /**
   * 找该控件所属的「可重复段」容器（多段经历用）。
   * 判据：类名像列表项，且父节点下至少有 2 个同类兄弟。
   * 只做记录，匹配作用域由 core/repeatable.js 负责 —— 它不依赖类名，
   * 因为真实的 ATS（如北森）类名是 styled-components 的哈希，一个语义词都没有。
   */
  function findScope(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6 && node !== document.body; depth++) {
      const cls = classOf(node);
      if (/item|card|block|experience|education|project|row/i.test(cls)) {
        const parent = node.parentElement;
        if (parent) {
          const sameCls = Array.from(parent.children).filter((c) => classOf(c) === cls);
          if (sameCls.length >= 2) {
            return { element: node, index: sameCls.indexOf(node), count: sameCls.length, className: cls };
          }
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * 页面上的「搜索/筛选」控件不是要填的字段。
   * 实测：北森页头的 `<input placeholder="搜索职位关键词">` 命中了「职位」的别名，
   * 被填成了「Java 后端开发工程师」—— 它只是个站内搜索框。
   * 只在 placeholder / name / id / aria-label 这类「控件自身属性」上判断，
   * 不用上下文文本，免得把正常字段误伤。
   */
  const SEARCH_HINT = /(搜索|查询|检索|关键字|关键词|search|keyword)/i;

  function isSearchBox(el) {
    const attrs = ["placeholder", "aria-label", "name", "id", "title"];
    for (const a of attrs) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && SEARCH_HINT.test(v)) return true;
    }
    return false;
  }

  /**
   * 扫描入口。
   * @returns {Array} 候选控件列表
   */
  function scan(root = document) {
    const controls = collectControls(root);
    const candidates = [];
    let idx = 0;

    for (const el of controls) {
      const kind = classify(el);
      if (!kind) continue;
      if (!RFA.isVisible(el)) continue;
      if (kind === "text" && isSearchBox(el)) continue;

      const ctx = collectContext(el);
      const cand = {
        el,
        idx: idx++,
        kind,
        ownLabel: kind === "radio" || kind === "checkbox" ? N.normalize(ownLabel(el)) : "",
        options: collectOptions(el, kind),
        ctx,
        required: isRequired(el, ctx),
        scope: findScope(el),
        maxLength: el.maxLength > 0 ? el.maxLength : 0
      };
      candidates.push(cand);
    }

    RFA.log(`扫描到 ${candidates.length} 个可填控件`);
    return candidates;
  }

  RFA.scan = {
    scan,
    collectContext,
    ownLabel,
    findFormItem,
    formItemChain,
    isSearchBox,
    classify,
    comboWrapperOf,
    comboTokenIn,
    COMBO_HINT_SELECTOR,
    NOISE_TEXT
  };
})();
