/**
 * popup：显示检测结果、触发填充、呈现三色汇总。
 *
 * 为什么要按 frame 逐个问：
 * 很多网申系统的表单嵌在 iframe 里，tabs.sendMessage 默认发给所有 frame 但只能拿到
 * 第一个响应，无法知道谁有表单。所以先用 scripting.executeScript 枚举每个 frame
 * （它跑在同一个隔离世界，能直接访问 __RFA），再按 frameId 精确投递。
 */
const $ = (id) => document.getElementById(id);

/**
 * popup 是普通扩展页面，core/ 里的模块都挂在自己的命名空间对象上（与 options.js 同一约定）。
 * 必须显式取一次：模块内部是 IIFE，那个局部的 RFA 不会泄漏到全局作用域。
 */
const RFA = globalThis.__RFA;

let activeTab = null;
let working = false;

function setPill(text, kind) {
  const el = $("profileState");
  el.textContent = text;
  el.className = `pill${kind ? " " + kind : ""}`;
}

function setHint(text) {
  $("detectHint").textContent = text || "";
}

/** 枚举各 frame 的可填控件数量；返回 null 表示无法注入该页面 */
async function collectFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const R = globalThis.__RFA;
        if (!R || !R.scan) return null;
        try {
          return R.scan.scan(document).length;
        } catch (e) {
          return 0;
        }
      }
    });
    return results
      .filter((r) => typeof r.result === "number")
      .map((r) => ({ frameId: r.frameId, count: r.result }));
  } catch (err) {
    return null;
  }
}

function addCounts(target, counts) {
  target.filled += counts.filled || 0;
  target.review += counts.review || 0;
  target.kept += counts.kept || 0;
  target.failed += counts.failed || 0;
  target.unmatched += counts.unmatched || 0;
  target.requiredUnmatched += counts.requiredUnmatched || 0;
  target.total += counts.total || 0;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function rowsHtml(entries, kind) {
  const filtered = kind === "review"
    ? entries.filter((e) => e.status === "filled" && e.level === "review" && !e.manual)
    : entries.filter((e) => e.status === kind);

  if (!filtered.length) return "";
  const title = kind === "review" ? "待确认" : kind === "failed" ? "填充失败" : kind === "kept" ? "已保留（页面原有内容）" : "未识别";

  const rows = filtered
    .slice(0, 8)
    .map((e) => {
      const seg = e.segment ? `<em class="seg">${esc(e.segment)}</em>` : "";
      const meta =
        e.status === "unmatched"
          ? "未识别"
          : e.status === "kept"
          ? esc(e.note || "已保留")
          : kind === "failed"
          ? esc(e.note || "失败")
          : esc(e.fieldLabel || "");
      return `<div class="row ${kind === "failed" ? "fail" : ""}"><span class="name">${seg}${esc(e.label)}${e.required ? " *" : ""}</span><span class="meta">${meta}</span></div>`;
    })
    .join("");

  const more = filtered.length > 8 ? `<div class="tip">还有 ${filtered.length - 8} 项，见页面右下角浮层</div>` : "";
  return `<div class="tip" style="color:#646a73">${title}（${filtered.length}）</div>${rows}${more}`;
}

function renderResult(merged) {
  const box = $("result");
  box.hidden = false;
  const manual = merged.entries.filter((e) => e.manual).length;
  const llm = merged.entries.filter((e) => e.llm).length;

  box.innerHTML = `
    <div class="stats">
      <span class="stat ok"><i></i>已填 ${merged.filled}</span>
      <span class="stat review"><i></i>待确认 ${merged.review}</span>
      ${merged.kept ? `<span class="stat kept"><i></i>已保留 ${merged.kept}</span>` : ""}
      <span class="stat failed"><i></i>失败 ${merged.failed}</span>
      <span class="stat unmatched"><i></i>未识别 ${merged.unmatched}</span>
      ${manual ? `<span class="stat manual"><i></i>手动 ${manual}</span>` : ""}
      ${llm ? `<span class="stat manual"><i></i>大模型 ${llm}</span>` : ""}
    </div>
    ${(merged.notes || []).length ? `<div class="notes">${merged.notes.map((n) => `<div>· ${esc(n)}</div>`).join("")}</div>` : ""}
    <div class="list">
      ${rowsHtml(merged.entries, "review")}
      ${rowsHtml(merged.entries, "kept")}
      ${rowsHtml(merged.entries, "failed")}
      ${rowsHtml(merged.entries, "unmatched")}
      ${
        !merged.entries.some((e) => e.status !== "filled" && e.status !== "unmatched")
          ? `<div class="tip">识别到的字段都已填充。</div>`
          : ""
      }
      <div class="tip">点页面上的标记可以手动指定字段。请核对后手动提交。</div>
    </div>
  `;
}

function renderTip(text) {
  const box = $("result");
  box.hidden = false;
  box.innerHTML = `<div class="tip">${esc(text)}</div>`;
}

async function refreshDetection() {
  const frames = await collectFrames(activeTab.id);
  if (frames === null) {
    $("fieldCount").textContent = "–";
    setHint("无法在这个页面运行（浏览器内置页面、扩展商店等不支持注入）。");
    $("fillBtn").disabled = true;
    return [];
  }

  const total = frames.reduce((n, f) => n + f.count, 0);
  $("fieldCount").textContent = String(total);
  $("fillBtn").disabled = total === 0;

  const withForm = frames.filter((f) => f.count > 0);
  if (!total) {
    setHint("没有检测到可填控件。如果是多步表单，切到下一步再点一次。");
  } else if (withForm.length > 1) {
    setHint(`分布在 ${withForm.length} 个区域（含 iframe），标题栏内容也已计入。`);
  } else {
    setHint("");
  }
  return withForm;
}

/** 手动映射记录直接读 storage：不必为了显示一个数字去问 content script */
async function manualKeys() {
  const bag = await chrome.storage.local.get("manualMap");
  const map = bag.manualMap || {};
  let host = "";
  try {
    host = new URL(activeTab.url).host;
  } catch (_) {
    /* chrome:// 之类没有 host */
  }
  if (!host) return [];
  return Object.keys(map).filter((k) => (map[k] && map[k].host) === host || k.startsWith(`${host}|`));
}

async function refreshManual() {
  const keys = await manualKeys();
  const row = $("manualRow");
  row.hidden = keys.length === 0;
  if (keys.length) $("manualText").textContent = `本站已记住 ${keys.length} 条手动映射`;
  return keys;
}

/** L3 状态行：没配置时也显示，让用户知道有这个东西、去哪儿配 */
async function refreshLlm() {
  const row = $("llmRow");
  const llm = RFA && RFA.llm;

  // core/llm.js 没加载成功时只降级显示，绝不抛出 —— init() 里这一句是 await 的，
  // 抛出去会把后面的「本站手动映射」「字段检测」一起带走（popup 看起来像卡住）。
  if (!llm) {
    row.hidden = false;
    $("llmText").textContent = "大模型补字段：模块未加载（不影响填充）";
    $("llmToggle").hidden = true;
    return null;
  }

  const s = await llm.getSettings();
  row.hidden = false;
  $("llmText").textContent = `大模型补字段：${llm.describe(s)}`;

  const btn = $("llmToggle");
  btn.hidden = !llm.isReady(s);
  btn.textContent = s.enabled ? "关闭" : "开启";
  return s;
}

async function doFill() {
  if (working) return;
  working = true;
  $("fillBtn").disabled = true;
  $("fillBtn").textContent = "填充中…";

  try {
    const frames = await collectFrames(activeTab.id);
    const targets = (frames || []).filter((f) => f.count > 0);
    if (!targets.length) {
      renderTip("当前页面没有检测到可填字段。");
      return;
    }

    const merged = { filled: 0, review: 0, kept: 0, failed: 0, unmatched: 0, requiredUnmatched: 0, total: 0, entries: [], notes: [] };
    const errors = [];

    for (const frame of targets) {
      try {
        const res = await chrome.tabs.sendMessage(activeTab.id, { type: "RFA", action: "fill" }, { frameId: frame.frameId });
        if (res && res.ok && res.summary) {
          addCounts(merged, res.summary.counts);
          merged.entries.push(...res.summary.entries);
          merged.notes.push(...(res.summary.notes || []));
        } else if (res && !res.ok) {
          errors.push(res.error);
        }
      } catch (err) {
        errors.push(err && err.message ? err.message : String(err));
      }
    }

    if (!merged.total && errors.length) {
      renderTip(`填充失败：${errors[0]}。请刷新页面后重试。`);
      return;
    }
    renderResult(merged);
    await refreshManual();
  } finally {
    working = false;
    $("fillBtn").textContent = "填充当前页";
    if ($("fieldCount").textContent !== "–") $("fillBtn").disabled = Number($("fieldCount").textContent) === 0;
  }
}

async function doClear() {
  const frames = await collectFrames(activeTab.id);
  for (const frame of frames || []) {
    try {
      await chrome.tabs.sendMessage(activeTab.id, { type: "RFA", action: "clear" }, { frameId: frame.frameId });
    } catch (_) {
      /* 忽略：该 frame 可能没有内容脚本 */
    }
  }
  $("result").hidden = true;
}

async function doClearManual() {
  const keys = await manualKeys();
  if (!keys.length) return;
  const bag = await chrome.storage.local.get("manualMap");
  const map = bag.manualMap || {};
  for (const k of keys) delete map[k];
  await chrome.storage.local.set({ manualMap: map });
  await refreshManual();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;

  const bag = await chrome.storage.local.get("profile");
  const p = bag.profile || {};
  const hasCore = !!(p.basic && p.basic.nameCn) && !!(p.contact && (p.contact.mobile || p.contact.email));
  setPill(hasCore ? "档案已就绪" : "档案待补全", hasCore ? "ok" : "warn");
  if (!hasCore) setHint("先去「编辑档案」把姓名和手机号填上，否则填不进去。");

  await refreshLlm();

  if (!activeTab) {
    $("fieldCount").textContent = "–";
    $("fillBtn").disabled = true;
    return;
  }

  await refreshManual();
  await refreshDetection();
}

$("fillBtn").addEventListener("click", doFill);
$("clearBtn").addEventListener("click", doClear);
$("manualClearBtn").addEventListener("click", doClearManual);
$("optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("llmToggle").addEventListener("click", async () => {
  if (!RFA || !RFA.llm) return;
  const s = await RFA.llm.getSettings();
  await RFA.llm.saveSettings({ enabled: !s.enabled });
  await refreshLlm();
});

init();
