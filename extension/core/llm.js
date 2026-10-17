/**
 * L3 的模型客户端（DESIGN.md 3.1 / 6.5）。
 *
 * 只做三件事：读写配置、拼请求、拿回文本。**不含任何匹配逻辑**（那在 llm-match.js 里），
 * 也不在加载时碰 chrome.* —— core/ 的模块要能在 Node 沙箱里直接跑单测。
 *
 * 真正的网络请求走 background（见 background/sw.js 的 llmChat）：
 * 内容脚本发出去，密钥不进页面上下文，超时与重试只实现一处。
 */
(function () {
  const RFA = globalThis.__RFA;

  const KEY = "llm";

  const DEFAULTS = {
    enabled: false,
    baseUrl: "",
    apiKey: "",
    model: "",
    timeoutMs: 8000,
    // 同一站点、同一套字段结构，在 TTL 内不重复问模型 —— 云端便宜也是钱，
    // 而且重复问会得到不完全一样的答案，体验很怪。
    cacheTtlMin: 1440,
    maxTokens: 1200
  };

  /** 任何 OpenAI 兼容端点都接受这种地址写法：补上缺的 /chat/completions */
  function endpointOf(baseUrl) {
    const base = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return "";
    if (/\/chat\/completions$/.test(base)) return base;
    return `${base}/chat/completions`;
  }

  function normalizeSettings(raw) {
    const s = Object.assign({}, DEFAULTS, raw || {});
    s.baseUrl = String(s.baseUrl || "").trim().replace(/\/+$/, "");
    s.model = String(s.model || "").trim();
    s.apiKey = String(s.apiKey || "").trim();
    s.timeoutMs = Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : DEFAULTS.timeoutMs;
    s.cacheTtlMin = Number.isFinite(Number(s.cacheTtlMin)) ? Number(s.cacheTtlMin) : DEFAULTS.cacheTtlMin;
    s.maxTokens = Number(s.maxTokens) > 0 ? Number(s.maxTokens) : DEFAULTS.maxTokens;
    s.enabled = !!s.enabled;
    return s;
  }

  async function getSettings() {
    const bag = await chrome.storage.local.get(KEY);
    return normalizeSettings(bag[KEY]);
  }

  async function saveSettings(patch) {
    const cur = await getSettings();
    const next = normalizeSettings(Object.assign({}, cur, patch || {}));
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  /** 端点与模型名是必需项；本地 Ollama 之类的实现不要 key，所以 key 不做必填 */
  function isReady(settings) {
    return !!(settings && settings.baseUrl && settings.model);
  }

  function describe(settings) {
    if (!isReady(settings)) return "未配置接口地址或模型名";
    if (!settings.enabled) return "已配置，但处于关闭状态";
    return `已启用 · ${settings.model}`;
  }

  function buildBody(settings, messages) {
    return {
      model: settings.model,
      messages,
      // 要的是稳定的字段对应关系，不是创作，温度必须压到 0
      temperature: 0,
      stream: false,
      max_tokens: settings.maxTokens
    };
  }

  /**
   * 传输层。默认走 background 转发；单测与 e2e 用 setTransport 注入桩。
   * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
   */
  let transport = null;

  function setTransport(fn) {
    transport = fn;
  }

  async function defaultTransport(payload) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "RFA_BG", action: "llmChat", payload });
      return res || { ok: false, error: "后台没有响应" };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  function withTimeout(promise, ms) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `超时（${ms}ms）` }), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * 发一轮对话，拿回模型输出的纯文本。
   * 超时重试一次（DESIGN.md 6.5 的降级链），仍失败就返回 ok:false —— 调用方跳过 L3，
   * L3 的任何异常都不允许阻塞填充主流程。
   */
  async function chat(messages, opts = {}) {
    const settings = normalizeSettings(opts.settings || (await getSettings()));
    if (!isReady(settings)) return { ok: false, error: "未配置大模型接口" };

    const payload = {
      endpoint: endpointOf(settings.baseUrl),
      apiKey: settings.apiKey,
      body: buildBody(settings, messages)
    };

    const send = transport || defaultTransport;
    const attempts = opts.retries === undefined ? 1 : opts.retries;

    let last = { ok: false, error: "未发起请求" };
    for (let i = 0; i <= attempts; i++) {
      last = await withTimeout(
        Promise.resolve(send(payload)).catch((err) => ({ ok: false, error: String((err && err.message) || err) })),
        opts.timeoutMs || settings.timeoutMs
      );
      if (last && last.ok) return last;
      // 配置类错误重试没有意义（地址都不对，再试一次也一样）
      if (last && /未配置|401|403/.test(String(last.error))) break;
    }
    return last;
  }

  /** options 页的「测试连接」：发一条最小请求，确认端点、密钥、模型名都能用 */
  async function testConnection(settings) {
    const s = normalizeSettings(settings);
    if (!isReady(s)) return { ok: false, error: "请先填写接口地址和模型名" };

    const res = await chat([{ role: "user", content: "ping" }], {
      settings: Object.assign({}, s, { maxTokens: 8 }),
      timeoutMs: Math.max(s.timeoutMs, 10000),
      retries: 0
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, text: String(res.text || "").slice(0, 80) };
  }

  RFA.llm = {
    KEY,
    DEFAULTS,
    endpointOf,
    normalizeSettings,
    getSettings,
    saveSettings,
    isReady,
    describe,
    buildBody,
    chat,
    testConnection,
    setTransport
  };
})();
