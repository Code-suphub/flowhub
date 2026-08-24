// 普通浏览器没有 Electron preload。这里提供只用于界面开发的兼容层：
// 导航配置来自真实 config.json，应用列表来自仅绑定本机的开发接口，
// 剪切板通过仅绑定 127.0.0.1 的只读接口读取真实历史。
if (!window.weborg) {
  document.documentElement.dataset.weborgRuntime = "browser";
  document.documentElement.dataset.weborgPage = location.pathname.includes("settings") ? "settings" : "search";
  document.documentElement.dataset.weborgReadonly = "true";
  const runtimeMode = document.getElementById("runtimeMode");
  if (runtimeMode) runtimeMode.textContent = "只读预览 · FlowHub";

  const configListeners = new Set();
  const clipboardListeners = new Set();
  const usageListeners = new Set();
  const fallbackApplications = [
    { title: "Safari", path: "/Applications/Safari.app", hay: "safari browser 浏览器" },
    { title: "Terminal", path: "/System/Applications/Utilities/Terminal.app", hay: "terminal 终端" },
    { title: "Finder", path: "/System/Library/CoreServices/Finder.app", hay: "finder 文件管理" },
    { title: "DataGrip", path: "/Applications/DataGrip.app", hay: "datagrip database 数据库" }
  ];

  async function getApplications(query = "", limit = 12) {
    try {
      const response = await fetch(`/__weborg/apps?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.reason || `读取应用失败：${response.status}`);
      return result.applications || [];
    } catch (error) {
      console.warn(`[flowhub preview] ${error.message}，使用预览应用数据`);
      const keyword = String(query).trim().toLowerCase();
      return fallbackApplications
        .filter((application) => !keyword || `${application.title} ${application.hay}`.toLowerCase().includes(keyword))
        .slice(0, limit);
    }
  }

  let configPromise;
  function getConfig() {
    if (!configPromise) {
      configPromise = fetch("/__weborg/config", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error(`读取配置失败：${response.status}`);
        return response.json();
      });
    }
    return configPromise.then((config) => JSON.parse(JSON.stringify(config)));
  }

  function flattenPages(nodes, path = []) {
    return (nodes || []).flatMap((node) => {
      const nextPath = [...path, { id: node.id, title: node.title }];
      const current = node.url ? [{ ...node, path: nextPath }] : [];
      return [...current, ...flattenPages(node.children || [], nextPath)];
    });
  }

  async function usageSections(scope = "all") {
    const [config, frequentApplications, recentApplications] = await Promise.all([
      getConfig(),
      getApplications("QQ", 1),
      getApplications("DataGrip", 1)
    ]);
    const pages = flattenPages(config.items || []);
    const appEntry = (application) => ({
      ...application,
      type: "app",
      usageKey: application.path
    });
    const pageEntry = (page) => ({
      ...page,
      type: "page",
      usageKey: page.id,
      breadcrumb: (page.path || []).map((entry) => entry.title).join(" / ")
    });
    const frequentApplication = frequentApplications[0] || fallbackApplications[0];
    const recentApplication = recentApplications[0] || fallbackApplications[3];
    const frequent = [frequentApplication && appEntry(frequentApplication), pages[0] && pageEntry(pages[0])].filter(Boolean);
    const recent = [recentApplication && appEntry(recentApplication), pages[1] && pageEntry(pages[1])].filter(Boolean);
    const allowed = (item) => scope === "all" || (scope === "app" ? item.type === "app" : scope === "web" ? item.type === "page" : false);
    return { frequent: frequent.filter(allowed), recent: recent.filter(allowed) };
  }

  window.weborg = {
    getConfig,
    async saveConfig(config) {
      const response = await fetch("/__weborg/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config)
      });
      const result = await response.json();
      if (!response.ok || !result.ok) return result;
      configPromise = Promise.resolve(result.config);
      configListeners.forEach((listener) => listener(result.config));
      return result;
    },
    async searchClipboard(query = "", kind = "all", limit = 30, offset = 0) {
      const response = await fetch(`/__weborg/clipboard/records?q=${encodeURIComponent(query)}&kind=${encodeURIComponent(kind)}&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.reason || `读取剪切板失败：${response.status}`);
      return result.records || [];
    },
    async searchApps(query = "") {
      return getApplications(query, 12);
    },
    searchUsage: usageSections,
    async copyClipboard() { return { ok: false, preview: true, readonly: true, reason: "浏览器剪切板预览为只读" }; },
    async deleteClipboard() { return { ok: false, preview: true, readonly: true, reason: "浏览器剪切板预览为只读" }; },
    async showClipboardMenu() { return { ok: false, preview: true, readonly: true, reason: "浏览器剪切板预览为只读" }; },
    async openUrl(url) {
      window.open(url, "_blank", "noopener,noreferrer");
      usageListeners.forEach((listener) => listener());
      return { ok: true, preview: true };
    },
    async openLocal(action) {
      console.info(`[flowhub preview] 浏览器不能启动本地应用：${action}`);
      return { ok: false, preview: true, reason: "浏览器预览不能启动本地应用" };
    },
    async openSettings() {
      window.open("/settings.html", "weborg-settings");
      return { ok: true, preview: true };
    },
    async openAccessibilitySettings() {
      return { ok: false, preview: true, reason: "请在 Electron App 中打开系统辅助功能设置" };
    },
    onConfig(listener) { configListeners.add(listener); },
    onClipboardUpdated(listener) { clipboardListeners.add(listener); },
    onUsageUpdated(listener) { usageListeners.add(listener); }
  };
}
