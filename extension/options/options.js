/**
 * options 页：按字段定义渲染档案编辑器 + 自定义类目 + 导入导出 + L3 配置。
 *
 * 内置表单完全由 extension/data/profile.schema.json 驱动 —— 想加内置字段改 JSON 即可（DESIGN.md 5.1）。
 * 用户自己加的类目与列则来自 core/custom.js（存在 chrome.storage.local 的 customFields 键里），
 * 两者在词典里是一回事，所以填写、匹配、填充走的是同一条链路。
 *
 * 一条硬规矩：编辑类目/列的定义时**不重渲染表单**（重渲染会丢焦点，光标每敲一个字都跳走）。
 * 只有增删这种结构性操作才 render()。
 */
const RFA = globalThis.__RFA;

let dict = null;
let profile = null;
let customDefs = RFA.custom.empty();
let saveTimer = null;
let customTimer = null;
let llmTimer = null;
let importReportTimer = null;
let llmSettings = null;

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function download(text, filename) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- 内置字段的渲染 ---------- */

function arrayNameOf(sec) {
  const key = sec.fields[0] && sec.fields[0].key;
  return key && key.includes("[].") ? key.split("[].")[0] : null;
}

function valueOf(field, arrIdx) {
  const v = RFA.profile.getValue(profile, field.key, arrIdx === undefined ? 0 : arrIdx);
  if (Array.isArray(v)) return v.join("\n");
  return v == null ? "" : String(v);
}

function attrsOf(field, arrIdx) {
  const idx = arrIdx === undefined ? "" : ` data-idx="${arrIdx}"`;
  return `data-key="${esc(field.key)}"${idx}`;
}

function controlHtml(field, arrIdx) {
  const attrs = attrsOf(field, arrIdx);
  const val = valueOf(field, arrIdx);

  switch (field.type) {
    case "textarea":
      return `<textarea rows="4" ${attrs} placeholder="${esc(field.example || "")}">${esc(val)}</textarea>`;
    case "array":
      return `<textarea rows="3" ${attrs} placeholder="每行一项">${esc(val)}</textarea>`;
    case "enum": {
      const opts = [`<option value="">（未填）</option>`].concat(
        (field.enum || []).map((o) => `<option value="${esc(o)}"${o === val ? " selected" : ""}>${esc(o)}</option>`)
      );
      return `<select ${attrs}>${opts.join("")}</select>`;
    }
    case "date":
      return `<input type="date" ${attrs} value="${esc(val)}" />`;
    case "dateYm":
      return `<input type="month" ${attrs} value="${esc(val)}" />`;
    case "number":
      return `<input type="number" ${attrs} value="${esc(val)}" />`;
    case "file":
      return `<input type="text" value="${esc(val)}" placeholder="暂不支持附件字段，先跳过" disabled />`;
    default:
      return `<input type="text" ${attrs} value="${esc(val)}" placeholder="${esc(field.example || "")}" />`;
  }
}

function fieldHtml(field, arrIdx) {
  const wide = field.type === "textarea" || field.type === "array";
  const label = `<label>${esc(field.label)}${
    field.required ? ' <b class="req">*</b>' : ""
  }${field.sensitive ? ' <span class="tag-sen">敏感</span>' : ""}</label>`;
  return `<div class="field${wide ? " wide" : ""}">${label}${controlHtml(field, arrIdx)}</div>`;
}

function sectionHtml(sec) {
  const arrName = arrayNameOf(sec);

  if (sec.repeatable && arrName) {
    const list = Array.isArray(profile[arrName]) ? profile[arrName] : [];
    const items = list
      .map(
        (_, i) => `
        <div class="item">
          <header>
            <span>第 ${i + 1} 段</span>
            <button class="tiny" data-del-arr="${arrName}" data-idx="${i}">删除</button>
          </header>
          <div class="grid">${sec.fields.map((f) => fieldHtml(f, i)).join("")}</div>
        </div>`
      )
      .join("");

    return `<section id="sec-${sec.id}">
      <header>
        <h2>${esc(sec.label)}</h2>
        <button data-add-arr="${arrName}">+ 添加一段</button>
      </header>
      ${sec.orderHint ? `<p class="hint">${esc(sec.orderHint)}</p>` : ""}
      <div class="items">${items || `<p class="hint">还没有内容，点右上角添加。</p>`}</div>
    </section>`;
  }

  return `<section id="sec-${sec.id}">
    <header><h2>${esc(sec.label)}</h2></header>
    ${sec.note ? `<p class="hint">${esc(sec.note)}</p>` : ""}
    <div class="grid">${sec.fields.map((f) => fieldHtml(f)).join("")}</div>
  </section>`;
}

/* ---------- 自定义类目的渲染 ---------- */

function customRowHtml(cat, f) {
  const key = RFA.custom.fieldKey(cat.id, f.id);
  const v = RFA.profile.getValue(profile, key, 0);
  return `<div class="crow">
    <input type="text" data-cat="${esc(cat.id)}" data-cf="${esc(f.id)}" data-cattr="label"
           value="${esc(f.label)}" placeholder="列名，如：生源地" />
    <input type="text" data-cat="${esc(cat.id)}" data-cf="${esc(f.id)}" data-cattr="aliases"
           value="${esc(RFA.custom.formatAliases(f.aliases))}" placeholder="其他叫法，逗号分隔（可选）" />
    <input type="text" data-key="${esc(key)}" value="${esc(v == null ? "" : v)}" placeholder="你要填的值" />
    <button class="tiny danger" data-del-cf="${esc(f.id)}" data-cat="${esc(cat.id)}" title="删除这一列">删除</button>
  </div>`;
}

function customSectionHtml(cat) {
  const rows = cat.fields.map((f) => customRowHtml(cat, f)).join("");
  return `<section id="sec-${esc(RFA.custom.sectionIdOf(cat.id))}" class="custom">
    <header>
      <h2><input class="cat-name" type="text" data-cat="${esc(cat.id)}" data-cattr="label"
                 value="${esc(cat.label)}" placeholder="类目名，如：某行网申特有" /></h2>
      <div class="cat-actions">
        <button data-add-cf="${esc(cat.id)}">＋ 新增列</button>
        <button class="tiny danger" data-del-cat="${esc(cat.id)}">删除类目</button>
      </div>
    </header>
    <div class="field wide">
      <label>限定网站 <span class="soft">（留空 = 所有网站；填 zhiye.com 就只在那个站点生效，多个用逗号分隔）</span></label>
      <input type="text" data-cat="${esc(cat.id)}" data-cattr="hosts"
             value="${esc(RFA.custom.formatHosts(cat.hosts))}" placeholder="留空 = 所有网站" />
    </div>
    ${
      cat.fields.length
        ? `<div class="crow-head"><span>列名</span><span>其他叫法</span><span>值</span><span></span></div>
           <div class="crows">${rows}</div>`
        : `<p class="hint">这个类目还没有列，点右上角「＋ 新增列」。</p>`
    }
  </section>`;
}

function customEmptyHtml() {
  return `<section class="custom-empty" id="sec-custom-empty">
    <header>
      <h2>自定义类目</h2>
      <button data-add-cat>＋ 新增类目</button>
    </header>
    <p class="hint">
      内置清单覆盖的是所有求职者都会遇到的字段；网申页上总还有一些是它自己的问法
      （「生源地」「应聘渠道」「是否服从调剂」…）。加一个类目、加几列、填一次值，以后这类字段就自动填了。
      也可以在页面上点未识别的红点，直接当场新建一列。
    </p>
  </section>`;
}

/* ---------- 渲染 ---------- */

function renderNav() {
  const builtin = dict.sections
    .filter((s) => !s.custom)
    .map((s) => `<a href="#sec-${esc(s.id)}">${esc(s.label)}</a>`)
    .join("");
  const custom = customDefs.categories
    .map((c) => `<a class="nav-cat" href="#sec-${esc(RFA.custom.sectionIdOf(c.id))}">${esc(c.label || "未命名类目")}</a>`)
    .join("");
  $("nav").innerHTML = builtin + (custom ? `<div class="nav-sep">自定义</div>${custom}` : "");
}

function render() {
  renderNav();
  const builtin = dict.sections.filter((s) => !s.custom).map(sectionHtml).join("");
  const custom = customDefs.categories.map(customSectionHtml).join("");
  $("form").innerHTML = builtin + (custom || customEmptyHtml());
}

function setSaveState(text, saved) {
  const el = $("saveState");
  el.textContent = text;
  el.className = `save-state${saved ? " saved" : ""}`;
}

function scheduleSave() {
  setSaveState("保存中…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await RFA.profile.save(profile);
    setSaveState("已保存", true);
  }, 350);
}

/**
 * 类目/列的定义变了：防抖存盘 + 重算词典。
 * 词典要跟着变，否则「重载词典」旁边显示的字段数还是旧的，
 * 下载导入模板时也带不上刚加的列。
 *
 * 注意这里**不能**写成 `customDefs = await RFA.custom.save(customDefs)`：
 * save 是异步的，await 期间用户可能又敲了一个字（patch 到 customDefs 上），
 * 等它返回再赋值，就把那个字盖回存盘前的旧快照了 —— 实测表现为「列名写了一半天，存下来是空的」。
 * 所以先用同步的 normalizeDefs 收敛，再把结果交给 save 去写。
 */
function scheduleCustomSave() {
  setSaveState("保存中…");
  clearTimeout(customTimer);
  customTimer = setTimeout(async () => {
    customDefs = RFA.custom.normalizeDefs(customDefs);
    await RFA.custom.save(customDefs);
    dict = await RFA.dict.refreshCustom();
    await updateDictState();
    setSaveState("已保存", true);
  }, 400);
}

function readControl(target) {
  const key = target.dataset.key;
  if (!key) return null;
  const idxRaw = target.dataset.idx;
  const idx = idxRaw === undefined ? undefined : Number(idxRaw);
  const field = dict.byKey[key];

  let value = target.value;
  if (field && field.type === "array") {
    value = value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return { key, idx, value };
}

/** 输入的这一格是在改「列的定义」吗（列名 / 其他叫法 / 限定网站） */
function readDefEdit(target) {
  const catId = target.dataset && target.dataset.cat;
  const attr = target.dataset && target.dataset.cattr;
  if (!catId || !attr) return null;
  return { catId, fieldId: target.dataset.cf || null, attr, value: target.value };
}

async function updateDictState() {
  const bag = await chrome.storage.local.get(["dict:loadedAt", "dict:aliases"]);
  const aliases = bag["dict:aliases"] || {};
  const total = Object.values(aliases).reduce((n, arr) => n + arr.length, 0);
  const when = bag["dict:loadedAt"] ? new Date(bag["dict:loadedAt"]).toLocaleString("zh-CN") : "未知";
  const mine = dict.customCount ? `（含自定义 ${dict.customCount} 个）` : "";
  $("dictState").innerHTML = `字段 ${dict.fields.length} 个${mine} · 别名 ${total} 条<br />加载于 ${when}`;
}

/* ---------- 导入 / 导出 ---------- */

/**
 * 导入的外部 JSON 多半是用户拿简历让大模型按导入模板生成的，
 * 所以这里要做的不是「原样塞进 storage」，而是收敛 + 汇报：
 * 空段丢掉、日期/枚举归一、枚举值不在候选里就说出来（否则只会等到页面上填不上才发现）。
 */
function showImportReport({ file, filled, droppedSegments, warnings }) {
  const box = $("importReport");
  const seen = new Set();
  const uniq = [];
  for (const w of warnings) {
    const k = `${w.fieldKey}|${w.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(w);
  }

  box.hidden = false;
  box.innerHTML = `
    <div><b>已从「${esc(file)}」导入</b>：填入 ${filled} 个字段${
      droppedSegments ? `，丢弃 ${droppedSegments} 个空段` : ""
    }。</div>
    ${
      uniq.length
        ? `<div class="warn">有 ${uniq.length} 个值不在该字段的候选范围内，页面上可能匹配不上，建议核对：${uniq
            .slice(0, 6)
            .map((w) => `${esc(w.label)}「${esc(w.value)}」`)
            .join("、")}${uniq.length > 6 ? ` 等` : ""}</div>`
        : ""
    }`;

  clearTimeout(importReportTimer);
  importReportTimer = setTimeout(() => {
    box.hidden = true;
  }, 20000);
}

/**
 * 把当前的自定义列补进导入模板。
 *
 * 不补的话会有一个很难自查的坑：用户拿模板让大模型填完整份简历，再导入回来，
 * 自定义列的值永远进不来 —— 因为模板里压根没有这些键。
 */
function withCustomFields(tpl) {
  const cats = customDefs.categories;
  if (!cats.length) return tpl;

  for (const cat of cats) {
    for (const f of cat.fields) {
      if (!f.label) continue;
      const key = RFA.custom.fieldKey(cat.id, f.id);
      const note = [`自定义类目「${cat.label || "未命名"}」`];
      if (f.aliases && f.aliases.length) note.push(`页面上也可能叫：${f.aliases.join("、")}`);
      if (cat.hosts && cat.hosts.length) note.push(`只在 ${cat.hosts.join("、")} 使用`);
      tpl.$fields[key] = { label: f.label, type: "text", note: note.join("；") };

      const group = RFA.custom.groupOf(cat.id);
      if (!tpl[group] || typeof tpl[group] !== "object") tpl[group] = {};
      if (!(f.id in tpl[group])) tpl[group][f.id] = "";
    }
  }

  tpl.$rules = (tpl.$rules || []).concat([
    "带 custom_ 前缀的键是「自定义类目」，属于用户自己加的列：分组名与键都由扩展生成，请原样保留，不要改名或搬家。"
  ]);
  return tpl;
}

/* ---------- L3 配置 ---------- */

function fillLlmForm(s) {
  $("llmEnabled").checked = s.enabled;
  $("llmBaseUrl").value = s.baseUrl;
  $("llmModel").value = s.model;
  $("llmApiKey").value = s.apiKey;
  $("llmTimeout").value = s.timeoutMs;
  $("llmCacheTtl").value = s.cacheTtlMin;
  $("llmState").textContent = RFA.llm.describe(s);
}

function currentLlmForm() {
  return {
    enabled: $("llmEnabled").checked,
    baseUrl: $("llmBaseUrl").value,
    model: $("llmModel").value,
    apiKey: $("llmApiKey").value,
    timeoutMs: Number($("llmTimeout").value) || RFA.llm.DEFAULTS.timeoutMs,
    cacheTtlMin: Number($("llmCacheTtl").value) || 0
  };
}

function scheduleLlmSave() {
  clearTimeout(llmTimer);
  llmTimer = setTimeout(async () => {
    llmSettings = await RFA.llm.saveSettings(currentLlmForm());
    $("llmState").textContent = RFA.llm.describe(llmSettings);
  }, 400);
}

/* ---------- 自定义类目的增删 ---------- */

async function persistCustom() {
  // 与 scheduleCustomSave 同理：同步收敛，不要拿异步返回值回写内存对象
  customDefs = RFA.custom.normalizeDefs(customDefs);
  await RFA.custom.save(customDefs);
  dict = await RFA.dict.refreshCustom();
  await updateDictState();
  setSaveState("已保存", true);
}

async function addCategoryAction() {
  customDefs = RFA.custom.addCategory(customDefs, "新类目");
  await persistCustom();
  render();
  const box = $("form").querySelector("section.custom:last-of-type input.cat-name");
  if (box) {
    box.focus();
    box.select();
  }
}

async function removeCategoryAction(catId) {
  const cat = RFA.custom.findCategory(customDefs, catId);
  if (!cat) return;
  const n = cat.fields.length;
  if (!confirm(`删除类目「${cat.label || "未命名"}」及其 ${n} 列？已填的值也会一起删掉。`)) return;

  customDefs = RFA.custom.removeCategory(customDefs, catId);
  await persistCustom();
  // 值跟着类目一起删：留着的话导出 JSON 里会有一堆没有列头的孤儿数据
  delete profile[RFA.custom.groupOf(catId)];
  await RFA.profile.save(profile);
  render();
}

async function addFieldAction(catId) {
  const cat = RFA.custom.findCategory(customDefs, catId);
  if (!cat) return;
  const nextId = `f${Number(cat.nextFieldId) || 1}`;
  customDefs = RFA.custom.addField(customDefs, catId, "");
  await persistCustom();
  render();
  const box = $("form").querySelector(`input[data-cat="${catId}"][data-cf="${nextId}"][data-cattr="label"]`);
  if (box) box.focus();
}

async function removeFieldAction(catId, fieldId) {
  customDefs = RFA.custom.removeField(customDefs, catId, fieldId);
  await persistCustom();
  const group = profile[RFA.custom.groupOf(catId)];
  if (group && typeof group === "object") delete group[fieldId];
  await RFA.profile.save(profile);
  render();
}

/* ---------- 事件 ---------- */

function onFormEdit(e) {
  const edit = readDefEdit(e.target);
  if (edit) {
    customDefs = edit.fieldId
      ? RFA.custom.patchField(customDefs, edit.catId, edit.fieldId, { [edit.attr]: edit.value })
      : RFA.custom.patchCategory(customDefs, edit.catId, { [edit.attr]: edit.value });
    // 类目名改了要立刻反映到左侧导航；只刷新导航，不重渲染表单（否则输入框会失焦）
    if (!edit.fieldId && edit.attr === "label") renderNav();
    scheduleCustomSave();
    return;
  }

  const parsed = readControl(e.target);
  if (!parsed) return;
  RFA.profile.setValue(profile, parsed.key, parsed.value, parsed.idx === undefined ? 0 : parsed.idx);
  scheduleSave();
}

$("form").addEventListener("input", onFormEdit);
$("form").addEventListener("change", onFormEdit);

$("form").addEventListener("click", async (e) => {
  const addBtn = e.target.closest("[data-add-arr]");
  if (addBtn) {
    const arrName = addBtn.dataset.addArr;
    if (!Array.isArray(profile[arrName])) profile[arrName] = [];
    profile[arrName].push({});
    render();
    scheduleSave();
    return;
  }

  const delBtn = e.target.closest("[data-del-arr]");
  if (delBtn) {
    const arrName = delBtn.dataset.delArr;
    const idx = Number(delBtn.dataset.idx);
    if (Array.isArray(profile[arrName])) {
      profile[arrName].splice(idx, 1);
      render();
      scheduleSave();
    }
    return;
  }

  if (e.target.closest("[data-add-cat]")) return addCategoryAction();

  const delCat = e.target.closest("[data-del-cat]");
  if (delCat) return removeCategoryAction(delCat.dataset.delCat);

  const addCf = e.target.closest("[data-add-cf]");
  if (addCf) return addFieldAction(addCf.dataset.addCf);

  const delCf = e.target.closest("[data-del-cf]");
  if (delCf) return removeFieldAction(delCf.dataset.cat, delCf.dataset.delCf);
});

$("addCategory").addEventListener("click", addCategoryAction);

$("exportBtn").addEventListener("click", () => {
  download(JSON.stringify(profile, null, 2), `简历档案-${new Date().toISOString().slice(0, 10)}.json`);
});

$("templateBtn").addEventListener("click", async () => {
  try {
    const res = await fetch(chrome.runtime.getURL("data/import-template.json"));
    const tpl = withCustomFields(await res.json());
    download(JSON.stringify(tpl, null, 2) + "\n", "简历档案-导入模板.json");
  } catch (err) {
    alert(`模板下载失败：${err.message}`);
  }
});

$("importBtn").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("不是合法的档案对象");

    const { profile: imported, warnings, filled, droppedSegments } = RFA.profile.coerceImported(parsed, dict);
    if (!filled) throw new Error("这份 JSON 里没有读到任何字段，确认是用「下载导入模板」得到的格式吗？");

    profile = imported;
    await RFA.profile.save(profile);
    render();
    setSaveState("已导入并保存", true);
    showImportReport({ file: file.name, filled, droppedSegments, warnings });
  } catch (err) {
    alert(`导入失败：${err.message}`);
  }
  e.target.value = "";
});

$("clearBtn").addEventListener("click", async () => {
  if (!confirm("确定清空本机保存的简历档案？建议先导出 JSON 备份。自定义类目与列会保留。")) return;
  profile = RFA.profile.emptyProfile();
  await RFA.profile.save(profile);
  render();
  setSaveState("已清空", true);
});

$("reloadDict").addEventListener("click", async () => {
  $("reloadDict").disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "RFA_BG", action: "reloadDict" });
    dict = await RFA.dict.reloadFromDisk();
    render();
    await updateDictState();
    setSaveState("词典已重载", true);
  } catch (err) {
    alert(`重载失败：${err.message}`);
  } finally {
    $("reloadDict").disabled = false;
  }
});

$("llmEnabled").addEventListener("change", scheduleLlmSave);
for (const id of ["llmBaseUrl", "llmModel", "llmApiKey", "llmTimeout", "llmCacheTtl"]) {
  $(id).addEventListener("input", scheduleLlmSave);
  $(id).addEventListener("change", scheduleLlmSave);
}

$("llmTest").addEventListener("click", async () => {
  const btn = $("llmTest");
  btn.disabled = true;
  $("llmState").textContent = "正在测试…";
  try {
    llmSettings = await RFA.llm.saveSettings(currentLlmForm());
    const res = await RFA.llm.testConnection(llmSettings);
    $("llmState").textContent = res.ok
      ? `连接正常，模型回复：${String(res.text || "(空)").slice(0, 30)}`
      : `失败：${res.error}`;
  } finally {
    btn.disabled = false;
  }
});

/* ---------- 启动 ---------- */

(async function init() {
  customDefs = await RFA.custom.load();
  dict = await RFA.dict.load();
  profile = await RFA.profile.get();
  render();
  await updateDictState();
  fillLlmForm(await RFA.llm.getSettings());
})();
