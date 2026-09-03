// 普通浏览器没有 Tauri 原生能力。这里提供只用于界面开发的兼容层：
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

  async function getApplications(query = "", limit = 12, offset = 0, includeIcons = true) {
    try {
      const response = await fetch(`/__weborg/apps?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}&icons=${includeIcons ? "1" : "0"}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.reason || `读取应用失败：${response.status}`);
      return result.applications || [];
    } catch (error) {
      console.warn(`[flowhub preview] ${error.message}，使用预览应用数据`);
      const keyword = String(query).trim().toLowerCase();
      return fallbackApplications
        .filter((application) => !keyword || `${application.title} ${application.hay}`.toLowerCase().includes(keyword))
        .slice(offset, offset + limit);
    }
  }

  async function loadAppIcons(paths = []) {
    const uniquePaths = [...new Set((paths || []).filter(Boolean))];
    if (!uniquePaths.length) return {};
    const response = await fetch(`/__weborg/app-icons?paths=${encodeURIComponent(JSON.stringify(uniquePaths))}`, { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.reason || `读取应用图标失败：${response.status}`);
    return result.icons || {};
  }

  async function lookupDns(hostname) {
    const queries = await Promise.allSettled(["A", "AAAA"].map(async (type) => {
      const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=${type}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`DNS 查询失败：${response.status}`);
      return response.json();
    }));
    const answers = queries
      .filter((query) => query.status === "fulfilled")
      .flatMap((query) => query.value?.Answer || []);
    if (!answers.length && queries.every((query) => query.status !== "fulfilled")) throw new Error("DNS 查询失败");
    const unique = [...new Map(answers.map((answer) => [`${answer.name || ""}|${answer.type}|${answer.data || ""}`, answer])).values()];
    return { ...(queries.find((query) => query.status === "fulfilled")?.value || {}), Answer: unique };
  }

  async function lookupLocalIp() {
    const local = await fetch("/__weborg/local-ip", { cache: "no-store" });
    if (local.ok) {
      const body = await local.json();
      if (body?.ipv4 || body?.ipv6) return body;
    }
    const readIp = async (endpoint) => {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("IP endpoint unavailable");
      const text = (await response.text()).trim();
      try { return JSON.parse(text).ip || ""; } catch { return text; }
    };
    const [ipv4, ipv6] = await Promise.allSettled([readIp("https://api4.ipify.org?format=json"), readIp("https://api6.ipify.org?format=json")]);
    if (ipv4.status === "fulfilled" || ipv6.status === "fulfilled") {
      return { ipv4: ipv4.status === "fulfilled" ? ipv4.value : "", ipv6: ipv6.status === "fulfilled" ? ipv6.value : "" };
    }
    for (const endpoint of ["https://ifconfig.me/ip", "https://icanhazip.com", "https://api.ipify.org?format=json"]) {
      try {
        const fallback = await fetch(endpoint, { cache: "no-store" });
        if (!fallback.ok) continue;
        const text = (await fallback.text()).trim();
        try { return { ipv4: JSON.parse(text).ip || "" }; } catch { return { ipv4: text }; }
      } catch {}
    }
    throw new Error("本机 IP 查询失败");
  }

  async function lookupIp(ip) {
    const address = String(ip || "").trim();
    if (!address) throw new Error("IP 地址为空");
    const response = await fetch(`/__weborg/ip?ip=${encodeURIComponent(address)}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) throw new Error(body?.reason || `IP 查询失败：${response.status}`);
    return body;
  }

  async function inspectCloudflare(hostname) {
    const value = String(hostname || "").trim();
    if (!value) throw new Error("域名为空");
    const response = await fetch(`/__weborg/cloudflare?hostname=${encodeURIComponent(value)}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) throw new Error(body?.reason || `Cloudflare 检测失败：${response.status}`);
    return body;
  }

  async function lookupProxy() {
    const config = await getConfig();
    const adapter = config?.plugins?.tools?.settings?.proxyAdapter || "auto";
    const response = await fetch(`/__weborg/proxy?adapter=${encodeURIComponent(adapter)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`代理检测失败：${response.status}`);
    return response.json();
  }

  let configPromise;
  let configCache;
  let webPageIndex;
  function ensureConfig() {
    if (!configPromise) {
      configPromise = fetch("/__weborg/config", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error(`读取配置失败：${response.status}`);
        return response.json();
      }).then((config) => (configCache = config));
    }
    return configPromise;
  }

  function getConfig() {
    return ensureConfig().then((config) => JSON.parse(JSON.stringify(config)));
  }

  function flattenPages(nodes, path = []) {
    return (nodes || []).flatMap((node) => {
      const nextPath = [...path, { id: node.id, title: node.title }];
      const current = node.url ? [{ ...node, path: nextPath }] : [];
      return [...current, ...flattenPages(node.children || [], nextPath)];
    });
  }

  async function indexedWebPages() {
    if (!webPageIndex) {
      const config = configCache || await ensureConfig();
      webPageIndex = flattenPages(config.plugins?.web?.settings?.items || []).map((page) => ({
        ...page,
        type: "page",
        breadcrumb: (page.path || []).map((entry) => entry.title).join(" / ")
      }));
    }
    return webPageIndex;
  }

  async function usageSections(scope = "all") {
    const [config, frequentApplications, recentApplications] = await Promise.all([
      getConfig(),
      getApplications("QQ", 1),
      getApplications("DataGrip", 1)
    ]);
    const pages = flattenPages(config.plugins?.web?.settings?.items || []);
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

  let pluginsPromise;
  async function listPlugins() {
    if (!pluginsPromise) {
      pluginsPromise = fetch("/plugins.json", { cache: "no-store" }).then((response) => response.json());
    }
    const [plugins, config] = await Promise.all([pluginsPromise, getConfig()]);
    return plugins.map((plugin) => ({
      ...plugin,
      available: ["web", "clipboard", "app", "memo", "tools"].includes(plugin.id),
      enabled: config.plugins?.[plugin.id]?.enabled ?? plugin.defaultEnabled !== false
    }));
  }

  async function pluginSearch(id, request = {}) {
    const plugin = (await listPlugins()).find((entry) => entry.id === id);
    if (!plugin?.available) throw new Error(`插件未安装：${id}`);
    if (!plugin.enabled) throw new Error(`插件未启用：${id}`);
    const query = String(request.query || "").trim().toLowerCase();
    const limit = Number(request.limit) || (id === "clipboard" ? 30 : 12);
    if (id === "clipboard") {
      const response = await fetch(`/__weborg/clipboard/records?q=${encodeURIComponent(request.query || "")}&kind=${encodeURIComponent(request.kind || "all")}&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(request.offset || 0)}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.reason || `读取剪切板失败：${response.status}`);
      return (result.records || []).map((record) => ({ ...record, pluginId: id }));
    }
    if (id === "app") {
      return (await getApplications(query, limit, Number(request.offset) || 0, request.includeIcons !== false)).map((record) => ({ ...record, pluginId: id }));
    }
    if (id === "web") {
      const pages = await indexedWebPages();
      return window.FlowHubWebSearch.rankWebPages(pages, query, limit, Number(request.offset) || 0)
        .map((record) => ({ ...record, pluginId: id }));
    }
    if (id === "memo") {
      const config = await getConfig();
      const configuredItems = config.plugins?.memo?.settings?.items;
      const items = Array.isArray(configuredItems) ? configuredItems : window.FlowHubMemoCatalog.cloneDefaults();
      return window.FlowHubMemoCatalog.rankMemos(items, query, limit, Number(request.offset) || 0)
        .map((record) => ({ ...record, pluginId: id }));
    }
    return [];
  }

  async function pluginAction(id, action, payload = {}) {
    if (["clipboard", "memo"].includes(id)) return { ok: false, preview: true, readonly: true, reason: "浏览器预览不能执行粘贴操作" };
    if (id === "web" && action === "activate") {
      window.open(payload.url, "_blank", "noopener,noreferrer");
      usageListeners.forEach((listener) => listener());
      return { ok: true, preview: true };
    }
    if (id === "app" && action === "activate") {
      console.info(`[flowhub preview] 浏览器不能启动本地应用：${payload.path}`);
      return { ok: false, preview: true, reason: "浏览器预览不能启动本地应用" };
    }
    return { ok: false, preview: true, reason: `插件 ${id} 不支持操作 ${action}` };
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
    listPlugins,
    pluginSearch,
    loadAppIcons,
    lookupDns,
    lookupLocalIp,
    lookupIp,
    inspectCloudflare,
    lookupProxy,
    pluginAction,
    searchUsage: usageSections,
    async openSettings(options = {}) {
      const url = String(options.initialUrl || "").trim();
      const query = url ? `?addUrl=${encodeURIComponent(url)}` : "";
      const settingsPath = `/settings.html${query}`;
      // The in-app browser preview does not expose window.open. Fall back to
      // same-tab navigation there; desktop Tauri keeps using its native window.
      if (document.documentElement.dataset.weborgRuntime !== "browser" && typeof window.open === "function") {
        const popup = window.open(settingsPath, "weborg-settings");
        if (popup) return { ok: true, preview: true };
      }
      window.location.assign(settingsPath);
      return { ok: true, preview: true };
    },
    async openAccessibilitySettings() {
      return { ok: false, preview: true, reason: "请在 FlowHub App 中打开系统辅助功能设置" };
    },
    async getMenuBarManagementState() {
      return { supported: false, trusted: false, nativeControl: false, mode: "preview" };
    },
    async requestMenuBarManagementPermission() {
      return { ok: false, trusted: false, preview: true, reason: "请在 FlowHub App 中授权辅助功能" };
    },
    async getConfigPathInfo() {
      try {
        const response = await fetch("/__weborg/config/location", { cache: "no-store" });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.reason || "读取配置文件位置失败");
        return result;
      } catch {
        const config = await getConfig();
        const configuredPath = String(config.core?.configPath || "").trim();
        return { available: false, configuredPath, defaultPath: "项目目录/config.json", resolvedPath: configuredPath || "项目目录/config.json", activePath: "" };
      }
    },
    async chooseConfigPath() {
      return { ok: false, preview: true, reason: "请在 FlowHub App 中选择配置文件位置" };
    },
    async openConfigPath() {
      return { ok: false, preview: true, reason: "请在 FlowHub App 中打开配置文件位置" };
    },
    async getClipboardStorageInfo() {
      try {
        const response = await fetch("/__weborg/clipboard/storage", { cache: "no-store" });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.reason || "读取存放位置失败");
        return result;
      } catch {
        const config = await getConfig();
        const configuredPath = String(config.plugins?.clipboard?.settings?.storagePath || "").trim();
        return { available: false, configuredPath, defaultPath: "FlowHub 用户数据目录/clipboard", resolvedPath: configuredPath || "FlowHub 用户数据目录/clipboard", activePath: "" };
      }
    },
    async chooseClipboardStorage() {
      return { ok: false, preview: true, reason: "请在 FlowHub App 中选择存放目录" };
    },
    async openClipboardStorage() {
      return { ok: false, preview: true, reason: "请在 FlowHub App 中打开存放目录" };
    },
    async getUpdateState() {
      return { supported: false, currentVersion: "0.1.0", status: "unsupported", availableVersion: "", percent: 0, error: "" };
    },
    async getDiagnosticsState() { return { enabled: false, available: false, path: "" }; },
    async setDiagnosticsEnabled() { return { ok: false, preview: true, reason: "浏览器预览不支持监控写入" }; },
    async sampleDiagnostics() { return { ok: false, preview: true, reason: "浏览器预览不支持监控采样" }; },
    async clearDiagnostics() { return { ok: false, preview: true, reason: "浏览器预览不支持清理监控数据" }; },
    async sendTestNotification() { return { ok: false, preview: true, reason: "请在 FlowHub App 中发送测试通知" }; },
    async toggleMenuBarItems() { return { ok: false, preview: true, reason: "请在 FlowHub App 中切换菜单栏隐藏区" }; },
    async checkForUpdates() {
      return { ok: false, preview: true, reason: "浏览器预览不能检查应用更新" };
    },
    async downloadUpdate() {
      return { ok: false, preview: true, reason: "浏览器预览不能下载应用更新" };
    },
    async quitAndInstallUpdate() {
      return { ok: false, preview: true, reason: "浏览器预览不能安装应用更新" };
    },
    onConfig(listener) { configListeners.add(listener); },
    onClipboardUpdated(listener) { clipboardListeners.add(listener); },
    onUsageUpdated(listener) { usageListeners.add(listener); },
    onUpdateState() { return () => {}; }
  };
}
