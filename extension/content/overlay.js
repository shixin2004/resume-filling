/**
 * 页面内浮层（DESIGN.md 8.2）。
 *
 * 全部挂在一个 Shadow DOM 里，避免被网申页面的全局 CSS 污染；
 * 同时因为宿主元素带了固定 id，扫描时会被 RFA.isOwnUI 排除，不会自己填自己。
 *
 * 交互原则：不遮挡页面、可一键收起、每个标记都能追溯到「这个值来自档案的哪个字段」，
 * 并且**每个标记都可以点** —— 点开就是手动指定字段的选择器（覆盖率兜底的最后一道防线）。
 */
(function () {
  const RFA = globalThis.__RFA;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: absolute; inset: 0; pointer-events: none; }
    .badge {
      position: absolute; width: 15px; height: 15px; border-radius: 50%;
      pointer-events: auto; cursor: pointer; border: 1.5px solid #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,.35);
      font: 500 9px/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #fff; display: flex; align-items: center; justify-content: center;
      padding: 0; margin: 0;
    }
    .badge.ok { background: #1d9e75; }
    .badge.review { background: #ef9f27; }
    .badge.failed { background: #e24b4a; }
    .badge.unmatched { background: #8c8c8c; }
    .badge.kept { background: #64748b; }
    .badge.manual { background: #185fa5; }

    .launcher {
      position: fixed; right: 18px; bottom: 18px; pointer-events: auto;
      display: flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 999px; border: 1px solid #d0d3d9;
      background: #fff; color: #1f2329; cursor: pointer;
      font: 500 13px/1.2 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      box-shadow: 0 4px 14px rgba(0,0,0,.14);
    }
    .launcher:hover { border-color: #185fa5; color: #185fa5; }
    .launcher .dot { width: 7px; height: 7px; border-radius: 50%; background: #1d9e75; }

    .panel {
      position: fixed; right: 18px; bottom: 18px; width: 320px; max-height: 62vh;
      pointer-events: auto; display: flex; flex-direction: column;
      background: #fff; border: 1px solid #d0d3d9; border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,.16); overflow: hidden;
      font: 400 12px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #1f2329;
    }
    .panel header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px; border-bottom: 1px solid #edeef0; background: #fafbfc;
    }
    .panel header b { font-size: 13px; font-weight: 500; }
    .panel .close {
      border: 0; background: transparent; cursor: pointer; color: #8a8f99;
      font-size: 15px; line-height: 1; padding: 2px 4px;
    }
    .stats { display: flex; gap: 10px; flex-wrap: wrap; padding: 9px 12px; border-bottom: 1px solid #edeef0; }
    .stat { display: flex; align-items: center; gap: 5px; }
    .stat i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .stat.ok i { background: #1d9e75; }
    .stat.review i { background: #ef9f27; }
    .stat.failed i { background: #e24b4a; }
    .stat.unmatched i { background: #8c8c8c; }
    .stat.kept i { background: #64748b; }
    .stat.manual i { background: #185fa5; }
    .list { overflow-y: auto; overflow-x: hidden; padding: 4px 0 6px; }
    .group-title { padding: 6px 12px 2px; color: #8a8f99; font-size: 11px; }
    /* 字段名不许被压缩/换行：以前的 flex:1 + break-all 会被后面那串 nowrap 的失败原因
       挤成一个字宽，中文逐字折行看起来就是竖排。失败原因（第 3 个 span）独占一行折行，
       也就不再把面板撑出横向滚动条。 */
    .row { padding: 5px 12px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 1px 6px; }
    .row:hover { background: #f6f7f9; }
    .row .name { flex: 0 0 auto; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .meta { color: #8a8f99; font-size: 11px; white-space: normal; overflow-wrap: anywhere; }
    .row .meta:nth-child(2) { margin-left: auto; }
    .row .meta:nth-child(3) { flex: 1 1 100%; }
    .row.fail .name { color: #a32d2d; }
    .seg { color: #185fa5; font-size: 11px; margin-right: 4px; }
    .notes { padding: 8px 12px; background: #fffaf0; border-bottom: 1px solid #f2e6d0; color: #8a6d3b; font-size: 11.5px; }
    .notes div + div { margin-top: 4px; }
    .foot {
      padding: 8px 12px; border-top: 1px solid #edeef0; background: #fafbfc;
      color: #8a8f99; font-size: 11px;
    }

    .picker {
      position: fixed; width: 320px; max-height: 400px; pointer-events: auto;
      display: flex; flex-direction: column; background: #fff;
      border: 1px solid #d0d3d9; border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,.18);
      overflow: hidden; z-index: 10;
      font: 400 12px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #1f2329;
    }
    .picker header {
      display: flex; align-items: baseline; gap: 6px; padding: 10px 12px 8px;
      border-bottom: 1px solid #edeef0; background: #fafbfc;
    }
    .picker header b { font-size: 13px; font-weight: 500; }
    .picker header .sub { flex: 1; color: #8a8f99; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .picker header .close { border: 0; background: transparent; cursor: pointer; color: #8a8f99; font-size: 15px; line-height: 1; padding: 0 2px; }
    .picker .search { padding: 8px 12px 4px; }
    .picker .search input {
      width: 100%; padding: 6px 9px; border: 1px solid #d9dde3; border-radius: 6px;
      font: inherit; outline: none;
    }
    .picker .search input:focus { border-color: #185fa5; }
    .picker .plist { overflow: auto; padding: 2px 0 6px; }
    .pgroup { padding: 7px 12px 2px; color: #8a8f99; font-size: 11px; }
    .pitem {
      display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
      padding: 5px 12px; border: 0; background: transparent; cursor: pointer; font: inherit;
      color: #1f2329;
    }
    .pitem:hover { background: #f2f6fb; }
    .pitem .pname { flex: 1; }
    .pitem .pval { color: #8a8f99; font-size: 11px; font-style: normal; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pitem .pval.empty { color: #c0c4cc; }
    .pitem.cur { background: #eaf2fd; }
    .pitem.cur .pname::after { content: " ·当前"; color: #185fa5; font-size: 11px; }
    .picker .pfoot {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 8px 12px; border-top: 1px solid #edeef0; background: #fafbfc; color: #8a8f99; font-size: 11px;
    }
    .picker .pfoot button {
      border: 1px solid #e0c3c3; background: #fff; color: #a32d2d; border-radius: 6px;
      padding: 3px 8px; cursor: pointer; font: inherit; flex-shrink: 0;
    }
    .picker .pfoot button:hover { border-color: #a32d2d; }

    /* 就地新建自定义列：档案里没有的字段，当场教会扩展 */
    .picker .newfield {
      padding: 8px 12px 10px; border-top: 1px solid #edeef0; background: #f7fafd;
      display: flex; flex-direction: column; gap: 6px;
    }
    .picker .newfield .nf-head { color: #185fa5; font-size: 11px; }
    .picker .newfield input {
      width: 100%; padding: 5px 8px; border: 1px solid #d9dde3; border-radius: 6px;
      font: inherit; outline: none; background: #fff;
    }
    .picker .newfield input:focus { border-color: #185fa5; }
    .picker .newfield .nf-add {
      border: 1px solid #c6d9ef; background: #fff; color: #185fa5; border-radius: 6px;
      padding: 5px 8px; cursor: pointer; font: inherit;
    }
    .picker .newfield .nf-add:hover { border-color: #185fa5; }
    .picker .newfield .nf-add[disabled] { opacity: .6; cursor: default; }
    .picker .newfield .nf-msg { color: #8a8f99; font-size: 11px; line-height: 1.5; }
    .picker .newfield .nf-msg.ok { color: #0f6e56; }
    .picker .newfield .nf-msg.bad { color: #a32d2d; }
  `;

  let host = null;
  let root = null;
  let layer = null;
  let panelEl = null;
  let launcherEl = null;
  let pickerEl = null;
  let badges = [];
  let lastReport = null;
  let rafPending = false;

  function ensureHost() {
    if (host && host.isConnected) return;

    host = document.createElement("div");
    host.id = RFA.HOST_ID;
    host.style.cssText = "position:fixed; inset:0; z-index:2147483000; pointer-events:none;";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><div class="layer"></div>`;

    layer = root.querySelector(".layer");
    (document.body || document.documentElement).appendChild(host);
  }

  /** 页面滚动/缩放后重新对齐标记位置 */
  function scheduleReposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      reposition();
    });
  }

  function reposition() {
    for (const item of badges) {
      if (!item.el || !item.el.isConnected) {
        item.node.style.display = "none";
        continue;
      }
      const rect = item.el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        item.node.style.display = "none";
        continue;
      }
      item.node.style.display = "flex";
      // 宿主是 fixed 定位，视口坐标可直接使用
      item.node.style.left = `${Math.round(rect.right - 9)}px`;
      item.node.style.top = `${Math.round(rect.top - 8)}px`;
    }
  }

  function clear() {
    if (host && host.isConnected) host.remove();
    host = root = layer = panelEl = launcherEl = pickerEl = null;
    badges = [];
    lastReport = null;
  }

  /** 收起浮层但保留检测结果 */
  function clearMarks() {
    if (layer) layer.innerHTML = "";
    badges = [];
    // 启动按钮/面板/选择器也在 layer 里，一起被清掉了，引用要一并作废
    launcherEl = null;
    panelEl = null;
    pickerEl = null;
  }

  /* ---------- 右下角启动按钮（对齐竞品的「一键启动」交互） ---------- */

  function showLauncher(count, onClick) {
    ensureHost();
    if (launcherEl) return;

    launcherEl = document.createElement("button");
    launcherEl.className = "launcher";
    launcherEl.innerHTML = `<span class="dot"></span>填充简历（${count} 项）`;
    launcherEl.addEventListener("click", onClick);
    layer.appendChild(launcherEl);
  }

  function hideLauncher() {
    if (launcherEl) {
      launcherEl.remove();
      launcherEl = null;
    }
  }

  /* ---------- 三色标注 ---------- */

  const GLYPH = { ok: "✓", review: "!", failed: "×", unmatched: "?", manual: "✎", kept: "=" };

  function badgeClassOf(entry) {
    if (entry.manual) return "manual";
    if (entry.status === "unmatched") return "unmatched";
    if (entry.status === "kept") return "kept";
    if (entry.status === "filled") return entry.level;
    return "failed";
  }

  function badgeTitle(entry) {
    const seg = entry.segment ? `${entry.segment} · ` : "";
    if (entry.status === "unmatched" || !entry.fieldKey) {
      return `${seg}${entry.label}：未识别${entry.required ? "（必填）" : ""} · 点这里手动指定字段`;
    }
    const flag = entry.manual ? "（手动指定）" : `（匹配分 ${entry.score}）`;
    return `${seg}${entry.label} → ${entry.fieldLabel}${flag}${entry.note ? " · " + entry.note : ""}`;
  }

  function paintBadge(item) {
    const cls = badgeClassOf(item.entry);
    item.node.className = `badge ${cls}`;
    item.node.textContent = GLYPH[cls] || "?";
    item.node.title = badgeTitle(item.entry);
  }

  /**
   * @param {Array} entries report.entries
   * @param {Function} onBadgeClick 点击任一标记的回调，参数是该 entry（点开手动指定选择器）
   */
  function showMarks(entries, onBadgeClick) {
    ensureHost();
    clearMarks();

    for (const entry of entries) {
      if (!entry.el) continue;
      const badge = document.createElement("button");
      const item = { el: entry.el, node: badge, entry };
      paintBadge(item);
      if (onBadgeClick) badge.addEventListener("click", () => onBadgeClick(entry));
      layer.appendChild(badge);
      badges.push(item);
    }

    reposition();
  }

  /** 手动指定字段 / 填充结果变化后，只刷新这一个标记和汇总面板 */
  function updateEntry(idx, patch) {
    const item = badges.find((b) => b.entry.idx === idx);
    if (!item) return null;
    Object.assign(item.entry, patch);
    paintBadge(item);
    if (lastReport) {
      RFA.report.recount(lastReport);
      if (panelEl) showPanel(lastReport);
    }
    return item.entry;
  }

  /* ---------- 手动指定字段的选择器 ---------- */

  function closePicker() {
    if (pickerEl) {
      pickerEl.remove();
      pickerEl = null;
    }
  }

  function pickerPosition(anchorEl) {
    const W = 320;
    const H = 400;
    let left = 18;
    let top = 18;
    try {
      const r = anchorEl.getBoundingClientRect();
      left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - W - 8));
      top = r.bottom + 8;
      if (top + H > window.innerHeight - 8) top = Math.max(8, r.top - H - 8);
    } catch (_) {
      /* 拿不到位置就用默认值 */
    }
    return { left, top };
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /**
   * 打开「指定字段」选择器。
   * @param {Object} opts
   *   entry            当前控件对应的 report entry
   *   sections         dict.sections（按分组渲染 + 分组标题）
   *   values           { [fieldKey]: 预览值 }（已经按正确的段号取好）
   *   mappedFieldKey   当前已映射的字段（高亮）
   *   onPick(key)      选中某个字段
   *   onClear()        有已记录的映射时才会给，用于清除
   */
  function showPicker(opts) {
    ensureHost();
    closePicker();

    const { entry, sections, values = {}, mappedFieldKey, onPick, onClear, onCreateNew } = opts;
    const pos = pickerPosition(entry.el);

    pickerEl = document.createElement("div");
    pickerEl.className = "picker";
    pickerEl.style.left = `${Math.round(pos.left)}px`;
    pickerEl.style.top = `${Math.round(pos.top)}px`;

    const groups = (sections || [])
      .map((sec) => {
        const items = (sec.fields || [])
          .map((f) => {
            const val = values[f.key] || "";
            const search = RFA.N.normalize([f.label].concat(f.alias || []).join(" "));
            const cur = f.key === mappedFieldKey ? " cur" : "";
            const valHtml = val
              ? `<em class="pval">${esc(val.length > 16 ? val.slice(0, 16) + "…" : val)}</em>`
              : `<em class="pval empty">档案为空</em>`;
            return `<button class="pitem${cur}" data-key="${esc(f.key)}" data-search="${esc(search)}"><span class="pname">${esc(f.label)}</span>${valHtml}</button>`;
          })
          .join("");
        if (!items) return "";
        return `<div class="pgroup">${esc(sec.label)}</div>${items}`;
      })
      .join("");

    pickerEl.innerHTML = `
      <header>
        <b>指定字段</b>
        <span class="sub">${esc(entry.label)}</span>
        <button class="close" title="关闭">×</button>
      </header>
      <div class="search"><input type="text" placeholder="搜索字段名，如：手机 / 学历 / shouji" /></div>
      <div class="plist">${groups}</div>
      ${
        onCreateNew
          ? `<div class="newfield">
              <div class="nf-head">＋ 档案里没有这一栏？新建一个自定义列（以后自动填）</div>
              <input class="nf-name" type="text" value="${esc(entry.label || "")}" placeholder="列名，如：生源地" />
              <input class="nf-value" type="text" placeholder="这一栏你要填的值（可留空，回头在设置页补）" />
              <button class="nf-add">建好并填入</button>
              <div class="nf-msg">建好后可在扩展设置页里改名字、加「其他叫法」、限定网站。</div>
            </div>`
          : ""
      }
      <div class="pfoot">
        <span>选中即填入并记住，下次同一网站自动生效</span>
        ${onClear ? `<button class="clear">清除记录</button>` : ""}
      </div>
    `;

    pickerEl.querySelector(".close").addEventListener("click", closePicker);

    const search = pickerEl.querySelector(".search input");
    search.addEventListener("input", () => {
      const q = RFA.N.normalize(search.value);
      pickerEl.querySelectorAll(".pgroup, .pitem").forEach((node) => {
        if (node.classList.contains("pgroup")) {
          node.hidden = false;
          return;
        }
        node.hidden = !!q && !node.dataset.search.includes(q);
      });
      // 整组都被过滤掉时，把标题也收起来
      let anyVisible = false;
      let currentGroup = null;
      Array.from(pickerEl.querySelector(".plist").children).forEach((node) => {
        if (node.classList.contains("pgroup")) {
          if (currentGroup) currentGroup.hidden = !anyVisible;
          currentGroup = node;
          anyVisible = false;
        } else if (!node.hidden) {
          anyVisible = true;
        }
      });
      if (currentGroup) currentGroup.hidden = !anyVisible;
    });

    pickerEl.querySelector(".plist").addEventListener("click", (ev) => {
      const btn = ev.target.closest(".pitem");
      if (!btn) return;
      closePicker();
      onPick(btn.dataset.key);
    });

    const addBtn = pickerEl.querySelector(".nf-add");
    if (addBtn && onCreateNew) {
      const nameInput = pickerEl.querySelector(".nf-name");
      const valueInput = pickerEl.querySelector(".nf-value");
      const msg = pickerEl.querySelector(".nf-msg");

      const say = (text, kind) => {
        msg.className = `nf-msg${kind ? " " + kind : ""}`;
        msg.textContent = text;
      };

      addBtn.addEventListener("click", async () => {
        const name = (nameInput.value || "").trim();
        if (!name) {
          say("先给它起个名字，比如「生源地」。", "bad");
          nameInput.focus();
          return;
        }

        addBtn.disabled = true;
        say("正在新建并填入…");
        let res;
        try {
          res = await onCreateNew(name, valueInput.value);
        } catch (err) {
          res = { ok: false, error: String((err && err.message) || err) };
        }

        if (res && res.ok) {
          const head = res.created === false ? `「${name}」已经有这一栏，已直接映射` : `已新建自定义列「${name}」`;
          say(res.withValue ? `${head}，并已填入该值。` : `${head}。到设置页填上值就会自动填。`, "ok");
          // 建完这一块就没用了，自动收起，免得连点建出一串重复列
          setTimeout(closePicker, 1800);
        } else {
          addBtn.disabled = false;
          say((res && (res.error || res.note)) || "新建失败", "bad");
        }
      });
    }

    const clearBtn = pickerEl.querySelector(".clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        closePicker();
        onClear();
      });
    }

    const onKey = (ev) => {
      if (ev.key === "Escape") {
        closePicker();
        document.removeEventListener("keydown", onKey, true);
      }
    };
    document.addEventListener("keydown", onKey, true);

    layer.appendChild(pickerEl);
    setTimeout(() => search.focus(), 0);
  }

  /* ---------- 汇总面板 ---------- */

  function rowHtml(entry) {
    const seg = entry.segment ? `<em class="seg">${esc(entry.segment)}</em>` : "";
    if (entry.status === "unmatched") {
      return `<div class="row"><span class="name">${seg}${esc(entry.label)}${entry.required ? " *" : ""}</span><span class="meta">未识别</span></div>`;
    }
    const meta =
      entry.status === "failed"
        ? `<span class="meta">失败</span>`
        : entry.status === "kept"
        ? `<span class="meta">已保留</span>`
        : `<span class="meta">${esc(entry.fieldLabel)}${entry.manual ? " ✎" : ""}${entry.level === "review" ? " ?" : ""}</span>`;
    const note = entry.note ? `<span class="meta">${esc(entry.note)}</span>` : "";
    return `<div class="row ${entry.status === "failed" ? "fail" : ""}"><span class="name">${seg}${esc(entry.label)}</span>${meta}${note}</div>`;
  }

  function showPanel(report) {
    ensureHost();
    lastReport = report;
    const c = report.counts;

    const failed = report.entries.filter((e) => e.status === "failed");
    const kept = report.entries.filter((e) => e.status === "kept");
    const review = report.entries.filter((e) => e.status === "filled" && e.level === "review" && !e.manual);
    const unmatched = report.entries.filter((e) => e.status === "unmatched" || (!e.fieldKey && e.status !== "failed"));
    const manual = report.entries.filter((e) => e.manual);
    const notes = report.notes || [];

    if (panelEl) panelEl.remove();

    panelEl = document.createElement("div");
    panelEl.className = "panel";
    panelEl.innerHTML = `
      <header>
        <b>填充结果</b>
        <button class="close" title="收起">×</button>
      </header>
      <div class="stats">
        <span class="stat ok"><i></i>已填 ${c.filled}</span>
        <span class="stat review"><i></i>待确认 ${c.review}</span>
        ${c.kept ? `<span class="stat kept"><i></i>已保留 ${c.kept}</span>` : ""}
        <span class="stat failed"><i></i>失败 ${c.failed}</span>
        <span class="stat unmatched"><i></i>未识别 ${c.unmatched}</span>
        ${manual.length ? `<span class="stat manual"><i></i>手动指定 ${manual.length}</span>` : ""}
      </div>
      ${notes.length ? `<div class="notes">${notes.map((n) => `<div>· ${esc(n)}</div>`).join("")}</div>` : ""}
      <div class="list">
        ${review.length ? `<div class="group-title">待确认（匹配分 60~84，请核对）</div>${review.map(rowHtml).join("")}` : ""}
        ${kept.length ? `<div class="group-title">已保留（页面原有内容，未覆盖）</div>${kept.map(rowHtml).join("")}` : ""}
        ${failed.length ? `<div class="group-title">填充失败</div>${failed.map(rowHtml).join("")}` : ""}
        ${unmatched.length ? `<div class="group-title">未识别${c.requiredUnmatched ? `（其中 ${c.requiredUnmatched} 项必填）` : ""}</div>${unmatched.map(rowHtml).join("")}` : ""}
        ${!review.length && !kept.length && !failed.length && !unmatched.length ? `<div class="group-title">全部识别并填充成功，请复核后手动提交</div>` : ""}
      </div>
      <div class="foot">点页面上的标记可以手动指定字段。扩展不会自动提交，也不会取消页面已有的勾选。</div>
    `;

    panelEl.querySelector(".close").addEventListener("click", () => {
      panelEl.remove();
      panelEl = null;
    });

    layer.appendChild(panelEl);
  }

  RFA.overlay = {
    showLauncher,
    hideLauncher,
    showMarks,
    showPanel,
    showPicker,
    closePicker,
    updateEntry,
    clear,
    clearMarks,
    scheduleReposition,
    getReport: () => lastReport
  };
})();
