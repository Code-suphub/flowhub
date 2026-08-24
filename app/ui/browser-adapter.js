// 普通浏览器没有 Electron preload。这里提供只用于界面开发的兼容层：
// 导航配置来自真实 config.json，剪切板和应用列表使用不含用户数据的预览内容。
if (!window.weborg) {
  document.documentElement.dataset.weborgRuntime = "browser";
  document.documentElement.dataset.weborgPage = location.pathname.includes("settings") ? "settings" : "search";

  const configListeners = new Set();
  const clipboardListeners = new Set();
  const usageListeners = new Set();
  const now = Date.now();
  let previewClipboard = [
    {
      id: 9001,
      kind: "text",
      content: "浏览器预览模式：这里展示剪切板文本的排版、搜索与展开效果。",
      hash: "preview-text-9001-0000000000000000000000000000000000000000000000",
      copyCount: 4,
      lastSeenAt: new Date(now - 70_000).toISOString()
    },
    {
      id: 9002,
      kind: "file",
      fileType: "folder",
      fileNames: ["Web Organization"],
      fileCount: 1,
      content: "/Users/example/Projects/Web Organization",
      hash: "preview-file-9002-000000000000000000000000000000000000000000000",
      copyCount: 2,
      lastSeenAt: new Date(now - 240_000).toISOString()
    },
    {
      id: 9003,
      kind: "text",
      content: [
        "curl --request GET 'https://api.example.com/v1/projects' \\",
        "  --header 'accept: application/json' \\",
        "  --header 'authorization: Bearer preview-token'"
      ].join("\n"),
      hash: "preview-long-9003-000000000000000000000000000000000000000000000",
      copyCount: 7,
      lastSeenAt: new Date(now - 420_000).toISOString()
    }
  ];

  const previewApplications = [
    { title: "Safari", path: "/Applications/Safari.app", hay: "safari browser 浏览器" },
    { title: "Terminal", path: "/System/Applications/Utilities/Terminal.app", hay: "terminal 终端" },
    { title: "Finder", path: "/System/Library/CoreServices/Finder.app", hay: "finder 文件管理" },
    { title: "DataGrip", path: "/Applications/DataGrip.app", hay: "datagrip database 数据库" }
  ];

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
    const config = await getConfig();
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
    const frequent = [appEntry(previewApplications[0]), pages[0] && pageEntry(pages[0])].filter(Boolean);
    const recent = [appEntry(previewApplications[3]), pages[1] && pageEntry(pages[1])].filter(Boolean);
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
    async searchClipboard(query = "") {
      const keyword = String(query).trim().toLowerCase();
      return previewClipboard.filter((record) => !keyword || [record.content, ...(record.fileNames || [])].join(" ").toLowerCase().includes(keyword));
    },
    async searchApps(query = "") {
      const keyword = String(query).trim().toLowerCase();
      return previewApplications.filter((application) => !keyword || `${application.title} ${application.hay}`.toLowerCase().includes(keyword));
    },
    searchUsage: usageSections,
    async copyClipboard(id) {
      const record = previewClipboard.find((entry) => entry.id === Number(id));
      if (record?.kind === "text" && navigator.clipboard?.writeText) await navigator.clipboard.writeText(record.content);
      return { ok: Boolean(record), preview: true };
    },
    async deleteClipboard(id) {
      previewClipboard = previewClipboard.filter((entry) => entry.id !== Number(id));
      clipboardListeners.forEach((listener) => listener());
      return { ok: true, preview: true };
    },
    async showClipboardMenu() { return { ok: true, preview: true }; },
    async openUrl(url) {
      window.open(url, "_blank", "noopener,noreferrer");
      usageListeners.forEach((listener) => listener());
      return { ok: true, preview: true };
    },
    async openLocal(action) {
      console.info(`[weborg preview] 浏览器不能启动本地应用：${action}`);
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
