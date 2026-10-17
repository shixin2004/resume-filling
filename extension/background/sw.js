/**
 * 后台 Service Worker。
 *
 * 职责：
 *   - 首次安装 / 浏览器启动时把词典文件写进 chrome.storage.local 缓存；
 *   - 给 options 页提供强制重载词典的接口；
 *   - 转发 L3 的大模型请求（DESIGN.md 3.1 模式 A 的轻量版）：
 *     内容脚本把「端点 + 密钥 + 请求体」发过来，由这里真正发 HTTP。
 *     放在这里而不是内容脚本里，一是绕开页面自身 CSP 对连接的干扰，
 *     二是密钥只经过扩展内部消息、不落在网页环境里，重试与超时也只实现一处。
 *
 * 注意：这里只是「转发 + 报错友好化」，不做任何字段判断 —— 那些在 core/ 里。
 */
const DICT_KEYS = { schema: "dict:schema", aliases: "dict:aliases", loadedAt: "dict:loadedAt" };

async function loadDictIntoStorage() {
  const [schemaRes, aliasRes] = await Promise.all([
    fetch(chrome.runtime.getURL("data/profile.schema.json")),
    fetch(chrome.runtime.getURL("data/field-aliases.json"))
  ]);
  const schema = await schemaRes.json();
  const aliasDoc = await aliasRes.json();

  await chrome.storage.local.set({
    [DICT_KEYS.schema]: schema,
    [DICT_KEYS.aliases]: aliasDoc.aliases || {},
    [DICT_KEYS.loadedAt]: Date.now()
  });

  return { fields: (schema.sections || []).reduce((n, s) => n + (s.fields || []).length, 0) };
}

/** 把 HTTP 状态码翻译成人能看懂的话，用户多半是在这里第一次配错地址 */
function explainHttp(status, bodyText) {
  const brief = String(bodyText || "").slice(0, 200).replace(/\s+/g, " ").trim();
  const hint =
    status === 401 || status === 403
      ? "密钥不对或没有权限"
      : status === 404
      ? "地址不对（通常要以 /v1 结尾）"
      : status === 429
      ? "被限流了，稍后再试"
      : status >= 500
      ? "对方服务出错了"
      : "请求被拒绝";
  return `HTTP ${status} · ${hint}${brief ? `：${brief}` : ""}`;
}

/** 从 OpenAI 兼容响应里取文本；顺带兼容只实现 /completions 的老实现 */
function textOf(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  if (!choice) return null;
  if (choice.message && typeof choice.message.content === "string") return choice.message.content;
  if (typeof choice.text === "string") return choice.text;
  return null;
}

async function llmChat(payload) {
  const endpoint = String((payload && payload.endpoint) || "").trim();
  const body = payload && payload.body;
  if (!endpoint) return { ok: false, error: "未配置接口地址" };
  if (!body || !body.model) return { ok: false, error: "未配置模型名" };

  const headers = { "Content-Type": "application/json" };
  if (payload.apiKey) headers.Authorization = `Bearer ${payload.apiKey}`;

  const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? `超时（${timeoutMs}ms）`
        : `连不上（${(err && err.message) || err}）。检查地址是否可从本机访问。`
    };
  } finally {
    clearTimeout(timer);
  }

  let text = "";
  try {
    text = await res.text();
  } catch (_) {
    text = "";
  }
  if (!res.ok) return { ok: false, error: explainHttp(res.status, text) };

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return { ok: false, error: "返回的不是 JSON（可能命中了网页而不是接口）" };
  }

  const content = textOf(data);
  if (content == null) return { ok: false, error: "返回里没有模型输出内容" };
  return { ok: true, text: content };
}

chrome.runtime.onInstalled.addListener(() => {
  loadDictIntoStorage()
    .then((r) => console.log("[RFA] 词典已就绪，字段数：", r.fields))
    .catch((err) => console.error("[RFA] 词典加载失败", err));
});

chrome.runtime.onStartup.addListener(() => {
  loadDictIntoStorage().catch((err) => console.error("[RFA] 词典加载失败", err));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "RFA_BG") return undefined;

  if (msg.action === "reloadDict") {
    loadDictIntoStorage()
      .then((r) => sendResponse({ ok: true, fields: r.fields }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (msg.action === "dictStatus") {
    chrome.storage.local
      .get([DICT_KEYS.loadedAt, DICT_KEYS.aliases])
      .then((bag) => {
        const aliases = bag[DICT_KEYS.aliases] || {};
        sendResponse({
          ok: true,
          loadedAt: bag[DICT_KEYS.loadedAt] || 0,
          aliasKeys: Object.keys(aliases).length,
          aliasTotal: Object.values(aliases).reduce((n, arr) => n + arr.length, 0)
        });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.action === "llmChat") {
    llmChat(msg.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  return undefined;
});
