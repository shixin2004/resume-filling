/**
 * 共享命名空间与基础工具。
 *
 * MV3 的 content_scripts 不支持 ES module，所以多个文件通过同一个隔离世界的全局对象
 * `globalThis.__RFA` 通信：manifest 里按顺序加载，每个文件往这个对象上挂自己的模块。
 */
(function () {
  const RFA = (globalThis.__RFA = globalThis.__RFA || {});

  // 刻意不在这里写版本号：manifest.json 才是唯一来源，第二处手抄的版本号迟早会漂。

  /** 浮层宿主元素的 id，用于把扩展自己的 UI 从表单扫描中排除 */
  RFA.HOST_ID = "rfa-overlay-host";

  RFA.log = function (...args) {
    console.log("[RFA]", ...args);
  };

  RFA.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  RFA.nextFrame = () =>
    new Promise((r) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));

  RFA.uid = () => Math.random().toString(36).slice(2, 10);

  /**
   * 带超时的条件等待：fn 返回真值即结束。
   * 用于等待下拉面板渲染、等待组件响应点击等。
   */
  RFA.waitFor = async function (fn, { timeout = 2000, interval = 50 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let v = null;
      try {
        v = fn();
      } catch (_) {
        v = null;
      }
      if (v) return v;
      if (Date.now() >= deadline) return null;
      await RFA.sleep(interval);
    }
  };

  /** 元素是否可见（用于过滤隐藏字段） */
  RFA.isVisible = function (el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none";
    }
    // 尺寸为 0 但父级可见：部分组件库用 0 尺寸 input 承载值
    const p = el.parentElement;
    if (!p) return false;
    const pr = p.getBoundingClientRect();
    if (pr.width === 0 && pr.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };

  /** 元素是否属于扩展自己的浮层（扫描时必须排除，否则会把自己的控件也当成表单字段） */
  RFA.isOwnUI = function (el) {
    try {
      let node = el;
      while (node) {
        if (node.id === RFA.HOST_ID) return true;
        const root = node.getRootNode && node.getRootNode();
        if (root && root.host) {
          node = root.host;
          continue;
        }
        node = node.parentNode;
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  };
})();
