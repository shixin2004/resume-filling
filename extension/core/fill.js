/**
 * 填充执行层（DESIGN.md 7）。
 *
 * 原则：
 *   - 每种控件类型有自己的做法，不奢望统一。
 *   - 填完必须读回校验，读回不一致就算失败（能抓住「假成功」）。
 *   - 串行 + 让帧，给框架渲染留时间。
 *   - 幂等：重复填充不会重复勾选、重复追加。
 *   - 单步失败不中断：一个控件失败只影响它自己。
 */
(function () {
  const RFA = globalThis.__RFA;
  const N = RFA.N;

  /* ---------- 基础原语 ---------- */

  const OK = (actual, note) => ({ status: "filled", actual: actual || "", note: note || "" });
  const FAIL = (note) => ({ status: "failed", actual: "", note: note || "" });
  /**
   * 页面上原本就有内容、且与档案不一致 —— 保留原值，不覆盖。
   *
   * 为什么单独一个状态而不是 failed：这不是错误。官网自己解析出来的内容、或者求职者
   * 已经手填的内容，通常比扩展的档案更新；覆盖掉才是真正的数据事故。
   */
  const KEPT = (actual, note) => ({ status: "kept", actual: actual || "", note: note || "页面上已有内容，未覆盖" });

  /** 组件显示的「请选择」这类占位文本，永远不算值 */
  const PLACEHOLDER_RE = /^(请选择|请填写|请输入|选择|please\s*(select|choose|input)|--|—|-|\/|无匹配数据)$/i;

  /**
   * 受控组件的关键：直接 el.value = x 不会更新 React/Vue 的 state，
   * 必须走原型上的原生 setter，再派发 input/change（DESIGN.md 7.1）。
   */
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function mouse(el, type) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  /** 组件库多数监听 mousedown，只派发 click 往往无效（DESIGN.md 7.3 第 0 步） */
  async function realClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    await RFA.nextFrame();
    mouse(el, "mousedown");
    mouse(el, "mouseup");
    mouse(el, "click");
  }

  function pressEscape() {
    ["keydown", "keyup"].forEach((t) =>
      document.dispatchEvent(new KeyboardEvent(t, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }))
    );
  }

  /**
   * 选完之后把自己打开的面板收掉。
   * 多选组件点完一个不会自动关，不收的话页面会一直挂着一块浮层挡着别的字段；
   * 只在「确实还有面板开着」时才按 Esc —— 免得在一个弹窗里误触把弹窗关了。
   */
  function closePanelIfOpen(panel) {
    if (panel && panel.isConnected && panel.getClientRects().length) pressEscape();
  }

  function isShown(node) {
    if (!node || !node.getClientRects) return false;
    if (!node.getClientRects().length) return false;
    const cs = getComputedStyle(node);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }

  /* ---------- 下拉/日期组件：找容器、找面板、找选项 ---------- */

  /** 控件所在的下拉组件容器（识别逻辑在 scan.js，与 classify 共用一套判据） */
  function comboWrapper(el) {
    return (RFA.scan && RFA.scan.comboWrapperOf && RFA.scan.comboWrapperOf(el)) || null;
  }

  /**
   * 该点哪里才会展开面板。
   * 组件库的可点区域五花八门：北森把整个 `.phoenix-select` 当触发器，
   * 而 antd 的 mousedown 只绑在 `.ant-select-selector` 上（点外层 `.ant-select` 不生效），
   * 所以优先找已知的「触发器子部件」，找不到才退回到容器本身。
   */
  function triggerOf(el, wrap) {
    if (!wrap) return el;
    const inner = wrap.querySelector(
      ".ant-select-selector, .el-select__wrapper, .el-select__caret, [class*='selector' i], [class*='trigger' i], [class*='inputWrapper' i]"
    );
    return inner || wrap;
  }

  /**
   * 读组件当前「显示」的值。
   *
   * 不能用 el.value：影子输入框里通常是空的，真正的值在展示层。
   * 判据同样不看类名表，而是三条结构规则：
   *   ① 跳过占位层（class 里带 placeHolder/placeholder 的节点，以及文本就是「请选择」的）
   *   ② 只取最里层文本（子元素里还有同样的文本，说明本节点是容器）
   *   ③ 跳过图标/箭头这类没有文本的节点
   */
  function readComboValue(el, wrap) {
    const box = wrap === undefined ? comboWrapper(el) : wrap;
    const own = (el.value || "").trim();

    if (box) {
      const parts = [];
      let nodes = [];
      try {
        nodes = Array.from(box.querySelectorAll("*"));
      } catch (_) {
        nodes = [];
      }
      for (const n of nodes) {
        if (n === el) continue;
        if (/^(input|select|textarea|svg|path|use|g|defs)$/i.test(n.tagName)) continue;
        const cls = typeof n.className === "string" ? n.className : "";
        if (/place-?holder|clearIcon|switchArrow/i.test(cls)) continue;
        if (!isShown(n)) continue;
        let childText = false;
        for (const c of n.children) {
          if ((c.textContent || "").trim()) {
            childText = true;
            break;
          }
        }
        if (childText) continue;
        const t = (n.textContent || "").trim();
        if (!t || t.length > 40) continue;
        if (PLACEHOLDER_RE.test(t)) continue;
        parts.push(t);
      }
      const shown = parts.join(" ").trim();
      if (shown) return shown;
    }
    return own;
  }

  /** 兼容旧接口名 */
  function readTriggerText(el) {
    if (el && el.tagName === "INPUT" && !comboWrapper(el)) return el.value || "";
    return readComboValue(el);
  }

  const PANEL_SELECTOR = [
    ".ant-select-dropdown",
    ".el-select-dropdown",
    ".el-popper",
    '[role="listbox"]',
    '[role="menu"]',
    '[class*="dropdown" i]',
    '[class*="select-menu" i]',
    '[class*="popup" i]',
    '[class*="popper" i]',
    '[class*="panel" i]',
    '[class*="listbox" i]',
    '[class*="cascader" i]'
  ].join(",");

  /** 选项可能把值写在属性上（antd 的日期格是 title="2024-06-15"，没有文本可读） */
  const OPTION_ATTRS = ["title", "aria-label", "data-value", "data-val", "data-date", "data-key", "value"];

  /**
   * 从面板里提取「可点选项」。
   *
   * 刻意不查类名白名单：真实 ATS 的面板类名（phoenix-select__panel / rc-virtual-list-holder-inner…）
   * 我们事先不可能穷举，穷举出来的表每换一个站点就失效一次。
   * 只按结构取：可见、里面没有别的表单控件、文本短、且是「最里层」的那一层元素。
   */
  function optionLeaves(root) {
    const out = [];
    let all = [];
    try {
      all = Array.from(root.querySelectorAll("li, div, span, td, dd, dt, a, p, option, [role]"));
    } catch (_) {
      return out;
    }
    for (const n of all) {
      if (!isShown(n)) continue;
      if (n.querySelector("input, select, textarea")) continue;
      const text = (n.textContent || "").trim();
      if (text.length > 60) continue;
      let hasInner = false;
      for (const c of n.children) {
        if (text && (c.textContent || "").trim() === text) {
          hasInner = true;
          break;
        }
      }
      if (hasInner) continue;
      const attrs = [];
      for (const a of OPTION_ATTRS) {
        const v = n.getAttribute && n.getAttribute(a);
        if (v) attrs.push(String(v));
      }
      if (!text && !attrs.length) continue;
      out.push({ node: n, text, attrs });
    }
    return out;
  }

  /**
   * 面板候选 → 选一个最像的。
   * 排序信号：① 里面有「我要找的那个值」→ 几乎可以确定是它；② 选项条数；③ 离触发器近；④ 是浮层。
   */
  function findPanel(trigger, captured, prefer) {
    const seen = new Set();
    const list = [];
    const add = (n) => {
      if (n && n.nodeType === 1 && !seen.has(n)) {
        seen.add(n);
        list.push(n);
      }
    };
    // 点开时才挂上去的节点最可靠（面板基本都是 portal 到 body 的）
    for (let i = captured.length - 1; i >= 0 && i >= captured.length - 40; i--) add(captured[i]);
    try {
      Array.from(document.querySelectorAll(PANEL_SELECTOR)).forEach(add);
    } catch (_) {
      /* 选择器不支持就只靠新增节点 */
    }

    const rect = trigger.getBoundingClientRect();
    let best = null;
    let bestScore = -Infinity;

    for (const node of list) {
      if (RFA.isOwnUI(node)) continue;
      if (!isShown(node)) continue;
      const raw = node.textContent || "";
      if (raw.length > 8000) continue; // 大容器（整块表单）不是面板

      // 「包着触发器的节点」只有它自己也是浮层时才可能是面板（有的库把下拉渲染在组件内部），
      // 否则它就是字段行/表单容器 —— 那些节点里的「短文本」是别的字段的标签，不是选项
      const cs = getComputedStyle(node);
      const floating = cs.position === "absolute" || cs.position === "fixed";
      if (node === trigger) continue;
      if (node.contains(trigger) && !floating) continue;

      const leaves = optionLeaves(node);
      if (!leaves.length) continue;

      let score = Math.min(leaves.length, 20) * 5;
      if (prefer && prefer.length) {
        for (const leaf of leaves) {
          const hay = [leaf.text].concat(leaf.attrs);
          if (hay.some((h) => prefer.some((p) => N.normalize(h) === N.normalize(p) || N.sameValue(h, p)))) {
            score += 2000;
            break;
          }
        }
      }
      if (floating) score += 25;
      const r = node.getBoundingClientRect();
      score -= Math.min(Math.abs(r.top - rect.bottom) + Math.abs(r.left - rect.left), 2000) / 50;

      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    return best;
  }

  /** 选项/属性文本与目标值的匹配打分（复用 L2 的值归一表，不另起一套标准） */
  function scoreOption(leaf, attempts, field, dict) {
    let best = 0;
    let bestAttempt = "";
    const hay = [leaf.text].concat(leaf.attrs);
    for (const cand of hay) {
      if (!cand) continue;
      for (const a of attempts) {
        let s = 0;
        if (N.normalize(cand) === N.normalize(a)) s = 100;
        else if (N.numEq(cand, a)) s = 98; // 面板写「6」、档案写「06」
        else if (N.sameValue(cand, a)) s = 96;
        else if (field && RFA.match.optionMatchesValue(cand, a, field, dict)) s = 92;
        else {
          const sim = N.similarity(cand, a);
          if (sim >= 0.8) s = 70 + sim * 10;
        }
        // 同分时优先「更长的写法」，避免「6」抢了「2003-06」该有的位置
        if (s > best || (s === best && a.length > bestAttempt.length)) {
          best = s;
          bestAttempt = a;
        }
      }
    }
    return { score: best, attempt: bestAttempt };
  }

  /**
   * 日期面板的「年月头」。
   * antd / Element 的日历默认只显示当前月，必须先点开顶部「2026年」这样的头切到年/月列表，
   * 我们才可能点到目标年份 —— 这是纯列表型面板之外唯一需要特殊处理的地方。
   */
  function panelHeaderToOpen(panel, target) {
    if (!/\d{4}/.test(String(target))) return null;
    let heads = [];
    try {
      heads = Array.from(panel.querySelectorAll("button, [class*='header' i], [class*='Header' i], [class*='view' i], [class*='title' i]"));
    } catch (_) {
      return null;
    }
    for (const h of heads) {
      const t = (h.textContent || "").trim();
      if (/^\d{4}\s*年?$/.test(t) || /^\d{1,2}\s*月$/.test(t)) return h;
    }
    return null;
  }

  /** 读回校验：显示值算不算把目标填进去了 */
  function accepts(actual, target, field, dict) {
    if (!actual) return false;
    if (N.coversValue(actual, target)) return true;
    return !!(field && RFA.match.optionMatchesValue(actual, target, field, dict));
  }

  /* ---------- 「页面上已有内容」的判定 ---------- */

  /** 控件自己的显示文本（单选/复选的选项名） */
  function ownText(el) {
    if (!el) return "";
    try {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && (l.textContent || "").trim()) return l.textContent.trim();
      }
    } catch (_) {
      /* CSS.escape 不可用时退回下面的写法 */
    }
    const wrap = el.closest && el.closest("label");
    if (wrap && (wrap.textContent || "").trim()) return wrap.textContent.trim();
    const sib = el.nextElementSibling;
    if (sib && (sib.textContent || "").trim()) return sib.textContent.trim();
    return (el.value || "").trim();
  }

  /** 同一组单选（优先 name，其次同容器下的 radio） */
  function radioGroupOf(el) {
    const name = el.getAttribute && el.getAttribute("name");
    if (name) {
      const root = el.form || el.ownerDocument || document;
      try {
        return Array.from(root.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`));
      } catch (_) {
        return [el];
      }
    }
    const p = el.parentElement;
    if (p) {
      const group = Array.from(p.querySelectorAll('input[type="radio"]'));
      if (group.length > 1) return group;
    }
    return [el];
  }

  /**
   * 控件当前「人看到的内容」。
   * 下拉/组件库必须走 readComboValue —— 直接读 el.value 会读到影子输入框里的空值，
   * 于是把「页面明明已经选了」误判成没填，接着就覆盖掉了（这正是要防的场景）。
   */
  function currentValueOf(cand) {
    const el = cand && cand.el;
    if (!el) return "";
    const kind = cand.kind;

    if (kind === "radio") {
      const hit = radioGroupOf(el).find((r) => r.checked);
      return hit ? ownText(hit) : "";
    }
    if (kind === "checkbox") {
      return el.checked ? ownText(el) || "已勾选" : "";
    }
    if (kind === "file") {
      return el.files && el.files.length ? "已选择文件" : "";
    }
    if (kind === "select") {
      const opt = el.selectedOptions && el.selectedOptions[0];
      if (!opt) return "";
      const text = (opt.textContent || "").trim();
      const val = String(opt.value == null ? "" : opt.value).trim();
      if (!text && !val) return "";
      if (text && PLACEHOLDER_RE.test(text)) return "";
      return text || val;
    }
    if (kind === "combobox") {
      return readComboValue(el) || "";
    }
    return (el.value || "").trim();
  }

  /** 有内容 = 非空、且不是「请选择」这类占位文本 */
  function hasMeaningful(text) {
    const t = String(text == null ? "" : text).trim();
    return !!t && !PLACEHOLDER_RE.test(t);
  }

  const MAX_ROUNDS = 4;

  /**
   * 自定义下拉（北森 phoenix / AntD / Element / Moka 等）。
   *
   * 流程：点开面板 → 在一轮一轮里找选项并点 → 每轮读回校验。
   * 之所以是「多轮」而不是「一次点完」，因为现实里值经常要分几次点才选得完：
   *   · 出生日期是「年 → 月」两级级联
   *   · 籍贯是「省 → 市」两级级联
   *   · 编程语言是多选，面板点完一个不关
   * 每轮只点「当前还缺的那一段」，点完就把这一段从待选值里去掉，然后再找下一个。
   */
  async function fillCombobox(pair, dict) {
    const { cand, value, field } = pair;
    const el = cand.el;
    if (el.disabled) return FAIL("控件被禁用");

    const target = String(value);
    const wrap = comboWrapper(el);
    const before = readComboValue(el, wrap);
    if (accepts(before, target, field, dict)) return OK(before, "已是目标值");

    // 面板多半是点开时才挂上去的，所以先挂观察器把它抓下来 —— 这样就不需要事先知道
    // 任何一家组件库的面板类名（真机上这类类名是哈希，猜一次废一次）。
    const captured = [];
    let observer = null;
    try {
      observer = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) if (n.nodeType === 1) captured.push(n);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {
      observer = null;
    }

    // 面板里出现「我要找的值」是最强的识别信号，这里把保守档与级联档一起给它做参考
    const query = (t) => N.valueAttempts(t || target, { cascade: true });
    let panel = null;
    let rest = target;
    let dayTried = false;
    const tried = new Set();
    const triedNodes = new Set();

    try {
      // 1. 打开面板。先点触发器，没反应再点 input —— 不同库绑的事件源不一样。
      const trigger = triggerOf(el, wrap);
      for (let attempt = 0; attempt < 2 && !panel; attempt++) {
        await realClick(attempt === 0 ? trigger : el);
        await RFA.sleep(attempt === 0 ? 100 : 160);
        panel = await RFA.waitFor(() => findPanel(el, captured, query()), { timeout: 1200, interval: 60 });
      }

      if (!panel) {
        if (!wrap) return await fillAsPlainInput(el, target, before);
        pressEscape();
        return FAIL("下拉面板没有打开，没能选中（可能需要键盘操作）");
      }

      // 2. 一轮一轮地把值点进去
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const leaves = optionLeaves(panel);
        let best = null;

        // 保守档找不到才放开级联档（前缀/分量），免得「深圳南山」被点成「深圳」
        for (let level = 0; level <= 1 && !best; level++) {
          const attempts = N.valueAttempts(rest, { cascade: level === 1 }).filter((a) => !tried.has(a));
          for (const leaf of leaves) {
            if (triedNodes.has(leaf.node)) continue;
            for (const a of attempts) {
              const s = scoreOption(leaf, [a], field, dict);
              if (s.score >= 70 && (!best || s.score > best.score)) best = { node: leaf.node, score: s.score, attempt: a };
            }
          }
        }

        if (!best) {
          // 日历面板：先点头部切到年/月列表，下一轮再找
          const head = round < 2 ? panelHeaderToOpen(panel, rest) : null;
          if (head && !triedNodes.has(head)) {
            triedNodes.add(head);
            await realClick(head);
            await RFA.sleep(180);
            const reopened = findPanel(el, captured, query(rest));
            if (!reopened) break;
            panel = reopened;
            continue;
          }
          break;
        }

        await realClick(best.node);
        triedNodes.add(best.node);
        tried.add(best.attempt);
        await RFA.sleep(round === 0 ? 120 : 200);

        const now = readComboValue(el, wrap);
        if (accepts(now, target, field, dict)) {
          closePanelIfOpen(panel);
          return OK(now);
        }

        // 级联/多选：把已经选中的那一段去掉，继续找下一段
        const nextRest = N.dropAttempt(rest, best.attempt);
        if (!nextRest || nextRest === rest) {
          // 待选值用完了、但面板还开着：说明后面可能还有一级。
          // 档案里是「年月」而组件要完整日期时就落到这里 —— 补点一次「1 日」（只允许补一次）。
          // 注意必须重新找一次面板：级联换级时组件常常是把旧面板删掉再挂一个新的。
          const reopened = findPanel(el, captured, query(rest));
          if (!dayTried && !nextRest && reopened && /^\d{4}-\d{2}$/.test(target)) {
            panel = reopened;
            dayTried = true;
            rest = "01";
            continue;
          }
          break;
        }
        rest = nextRest;
        const next = findPanel(el, captured, N.valueAttempts(rest));
        if (!next) break;
        panel = next;
      }

      // 3. 收尾读回
      const actual = readComboValue(el, wrap);
      if (accepts(actual, target, field, dict)) {
        closePanelIfOpen(panel);
        return OK(actual);
      }
      pressEscape();
      if (!actual) return FAIL(`下拉里没选中「${target}」`);
      return FAIL(`点选后读回不一致（期望「${target}」，实际「${actual}」）`);
    } finally {
      if (observer) observer.disconnect();
    }
  }

  /** 下拉面板没出现时的退路：临时解除 readOnly 直接写值，再读回校验 */
  async function fillAsPlainInput(el, target, before) {
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return FAIL("无法识别的下拉组件");

    const wasReadonly = el.readOnly;
    if (wasReadonly) el.readOnly = false;
    setNativeValue(el, target);
    await RFA.nextFrame();
    const actual = el.value || "";
    if (wasReadonly) el.readOnly = true;

    if (N.sameValue(actual, target) || N.normalize(actual) === N.normalize(target)) return OK(actual, "按普通输入框写入");
    return FAIL("组件未接受写入");
  }

  /* ---------- 各类控件的填充 ---------- */

  async function fillText(pair) {
    const { cand, value } = pair;
    const el = cand.el;
    if (el.disabled) return FAIL("控件被禁用");

    // 兜底自检：会走到这里说明 classify 漏判了。写进影子输入框的话，读回 el.value 是「成功」的，
    // 但页面上什么都没变 —— 与其报个假成功，不如直说。
    if (comboWrapper(el)) return FAIL("这是下拉组件的内部输入框，需要点开选择");

    let v = String(value);
    if (cand.maxLength > 0 && v.length > cand.maxLength) v = v.slice(0, cand.maxLength);

    const before = el.value || "";
    setNativeValue(el, v);
    await RFA.nextFrame();

    const actual = el.value || "";
    if (actual === v) return OK(actual);
    if (actual && actual !== before) return OK(actual, "值被组件改写（可能是长度或格式限制）");
    return FAIL(`写入未生效（当前值：${actual || "空"}）`);
  }

  async function fillSelect(pair, dict) {
    const { cand, value, field } = pair;
    const el = cand.el;
    if (el.disabled) return FAIL("控件被禁用");

    const target = String(value);
    let best = null;
    let bestScore = 0;

    for (const opt of Array.from(el.options || [])) {
      const t = (opt.textContent || "").trim();
      if (!t) continue;
      let s = 0;
      if (N.normalize(t) === N.normalize(target)) s = 100;
      else if (N.sameValue(t, target)) s = 90;
      else if (RFA.match.optionMatchesValue(t, target, field, dict)) s = 88;
      else {
        const sim = N.similarity(t, target);
        if (sim >= 0.8) s = 70 + sim * 10;
      }
      if (s > bestScore) {
        bestScore = s;
        best = opt;
      }
    }

    if (!best || bestScore < 70) return FAIL(`下拉里找不到「${target}」`);

    setNativeValue(el, best.value);
    await RFA.nextFrame();
    const actual = (el.selectedOptions[0] || {}).textContent || "";
    return N.normalize(actual) === N.normalize(best.textContent) || actual.trim()
      ? OK(actual.trim())
      : FAIL("选中后读回为空");
  }

  /**
   * 单选 / 复选。
   * 只勾选匹配项，从不主动取消勾选（避免破坏页面上已有的默认值）。
   */
  async function fillChoice(pair) {
    const el = pair.cand.el;
    if (el.disabled) return FAIL("控件被禁用");
    if (el.checked) return OK("已选中", "原本就是选中状态");

    await realClick(el);
    await RFA.nextFrame();
    if (!el.checked) {
      const label = el.closest("label") || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      if (label) {
        await realClick(label);
        await RFA.nextFrame();
      }
    }
    return el.checked ? OK("已选中") : FAIL("点击后仍未选中");
  }

  async function fillDate(pair) {
    const { cand, value } = pair;
    const el = cand.el;
    // 组件库的日期（北森 phoenix-select 之类）由 fillCombobox 负责，走不到这里
    if (comboWrapper(el)) return await fillCombobox(pair, pair.dict);
    const raw = String(value);
    // date 输入框需要完整日期；档案里通常只精确到月
    const v = /^\d{4}-\d{2}$/.test(raw) ? `${raw}-01` : raw;
    return await fillText({ cand, value: v, field: pair.field });
  }

  /* ---------- 调度 ---------- */

  const HANDLERS = {
    text: fillText,
    number: fillText,
    textarea: fillText,
    email: fillText,
    tel: fillText,
    url: fillText,
    select: fillSelect,
    combobox: fillCombobox,
    radio: fillChoice,
    checkbox: fillChoice,
    date: fillDate,
    file: async () => FAIL("文件上传尚未支持（计划在 M2 补齐）")
  };

  /**
   * 填充一批配对结果。串行执行，单项失败不影响后续。
   *
   * 默认**不覆盖页面上已有的内容**：官网自己解析出来的、或求职者已经手填的内容优先。
   * 只有「手动指定字段」这种用户显式操作才传 opts.force = true 覆盖。
   *
   * @returns {Array} 与 pairs 等长的结果数组
   */
  async function fillAll(pairs, dict, opts) {
    const force = !!(opts && opts.force);
    const results = [];
    for (const pair of pairs) {
      const handler = HANDLERS[pair.cand.kind];
      let res;
      try {
        if (!force) {
          const cur = currentValueOf(pair.cand);
          if (hasMeaningful(cur)) {
            const target = String(pair.value == null ? "" : pair.value);
            res = accepts(cur, target, pair.field, dict)
              ? OK(cur, "已是目标值")
              : KEPT(cur, `页面上已有「${cur}」，未覆盖`);
            results.push(res);
            await RFA.nextFrame();
            continue;
          }
        }

        res = handler ? await handler(Object.assign({ dict }, pair), dict) : FAIL(`不支持的控件类型：${pair.cand.kind}`);
      } catch (err) {
        res = FAIL(`填充异常：${err && err.message ? err.message : String(err)}`);
      }
      results.push(res);
      await RFA.nextFrame();
    }
    return results;
  }

  RFA.fill = {
    fillAll,
    setNativeValue,
    realClick,
    readTriggerText,
    readComboValue,
    comboWrapper,
    optionLeaves,
    findPanel,
    currentValueOf,
    hasMeaningful,
    HANDLERS
  };
})();
