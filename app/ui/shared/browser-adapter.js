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
  // Explicit, isolated UI fixture. Native windows and normal browser previews
  // continue to use their existing adapters and data sources.
  const demo = !window.__TAURI__ && /(?:^|[?&])preview=demo(?:&|$)/.test(location.search || "");
  const demoIcon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='8' fill='%236f8eaa'/%3E%3C/svg%3E";
  const demoApplications = ["FlowHub", "Visual Studio Code · 团队共享项目与开发工具", "Safari", "Terminal", "DataGrip", "Notes", "Figma", "Preview"].map((title, index) => ({
    id: `demo-app-${index}`, title, path: `/Applications/团队工具与长期维护项目/界面交互体验验证/${title}.app`, hay: `${title} demo 演示 应用`, iconUrl: demoIcon
  }));
  const demoPages = ["项目工作台", "设计规范 · 组件交互、可访问性和跨窗口导航完整说明", "代码仓库", "团队知识库", "运行状态", "发布记录", "API 参考", "产品反馈"].map((title, index) => ({
    id: `demo-web-${index}`, title, url: `https://example.com/teams/flowhub/documentation/interaction-and-layout-review/${index}`, icon: demoIcon
  }));
  const demoMemos = Array.from({length:8}, (_, index) => ({id:`demo-memo-${index}`, title:index ? `开发命令 ${index}` : "查看所有服务日志并定位较长的异常上下文", category:"演示 / 开发 / 排查", content:`docker compose --project-name flowhub-preview --file /Users/demo/Projects/FlowHub/deployment/compose.production.yml logs --tail 200 --follow service-${index}`}));
  const demoClipboard = Array.from({length:8}, (_, index) => ({id:index+1, kind:"text", content:`演示剪贴板 ${index+1}：用于验证长文本展开、键盘选择和滚动保持。\n${"这一段包含较长的工作记录与界面验收说明，展开后应完整呈现且保持选中对象。\n".repeat(8)}`, hash:`demo-clipboard-${index}`, copyCount:index+1, createdAt:"2026-10-16T08:00:00Z", lastSeenAt:"2026-10-16T08:00:00Z"}));
  const demoConfig = {core:{},plugins:{
    app:{enabled:true,settings:{}}, web:{enabled:true,settings:{items:[{id:"demo-folder",title:"演示 / 团队资料 / 较长的目录路径",children:demoPages}]}},
    clipboard:{enabled:true,settings:{}}, memo:{enabled:true,settings:{items:demoMemos}}, tools:{enabled:false,settings:{}}
  }};
  const fallbackApplications = [
    { title: "Safari", path: "/Applications/Safari.app", hay: "safari browser 浏览器" },
    { title: "Terminal", path: "/System/Applications/Utilities/Terminal.app", hay: "terminal 终端" },
    { title: "Finder", path: "/System/Library/CoreServices/Finder.app", hay: "finder 文件管理" },
    { title: "DataGrip", path: "/Applications/DataGrip.app", hay: "datagrip database 数据库" }
  ];

  async function getApplications(query = "", limit = 12, offset = 0, includeIcons = true) {
    if (demo) {
      const keyword=String(query).trim().toLowerCase();
      return demoApplications.filter(item=>!keyword || `${item.title} ${item.hay} ${item.path}`.toLowerCase().includes(keyword)).slice(offset,offset+limit);
    }
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
    if (demo) return Object.fromEntries(paths.filter(path=>demoApplications.some(app=>app.path===path)).map(path=>[path,demoIcon]));
    const uniquePaths = [...new Set((paths || []).filter(Boolean))];
    if (!uniquePaths.length) return {};
    const response = await fetch(`/__weborg/app-icons?paths=${encodeURIComponent(JSON.stringify(uniquePaths))}`, { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.reason || `读取应用图标失败：${response.status}`);
    return result.icons || {};
  }

  async function lookupDns(hostname) {
    if (demo) throw new Error("演示模式不执行网络查询");
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

  async function lookupLocalIp(onProgress, options) {
    if (demo) throw new Error("演示模式不执行网络查询");
    return window.FlowHubLookupPublicIp(onProgress, options);
  }

  async function lookupIp(ip) {
    if (demo) throw new Error("演示模式不执行网络查询");
    const address = String(ip || "").trim();
    if (!address) throw new Error("IP 地址为空");
    const response = await fetch(`/__weborg/ip?ip=${encodeURIComponent(address)}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) throw new Error(body?.reason || `IP 查询失败：${response.status}`);
    return body;
  }

  async function inspectCloudflare(hostname) {
    if (demo) throw new Error("演示模式不执行网络查询");
    const value = String(hostname || "").trim();
    if (!value) throw new Error("域名为空");
    const response = await fetch(`/__weborg/cloudflare?hostname=${encodeURIComponent(value)}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) throw new Error(body?.reason || `Cloudflare 检测失败：${response.status}`);
    return body;
  }

  async function lookupProxy() {
    if (demo) throw new Error("演示模式不执行网络查询");
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
    if (demo) return Promise.resolve(demoConfig);
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
      if (!webPageIndex) webPageIndex = window.FlowHubWebSearch.createWebPageIndex(flattenPages(config.plugins?.web?.settings?.items || []).map((page) => ({
        ...page,
        type: "page",
        breadcrumb: (page.path || []).map((entry) => entry.title).join(" / ")
      })));
    }
    return webPageIndex;
  }

  async function usageSections(scope = "all") {
    if (demo) {
      const appEntry=app=>({...app,type:"app",usageKey:app.path});
      const pageEntry=page=>({...page,type:"page",usageKey:page.id,breadcrumb:"演示 / 团队资料 / 交互体验验证"});
      const allowed=item=>scope==="all" || (scope==="app" ? item.type==="app" : scope==="web" && item.type==="page");
      return {frequent:[...demoApplications.slice(0,4).map(appEntry),...demoPages.slice(0,4).map(pageEntry)].filter(allowed),recent:[...demoPages.slice(4).map(pageEntry),...demoApplications.slice(4).map(appEntry)].filter(allowed)};
    }
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
    if (demo) return ["app","web","clipboard","memo","tools"].map((id,order)=>({id,name:{app:"应用",web:"网页",clipboard:"剪贴板",memo:"命令备忘录",tools:"工具"}[id],order,available:true,enabled:demoConfig.plugins[id].enabled,searchable:id!=="tools"}));
    if (!pluginsPromise) {
      pluginsPromise = fetch("/plugins.json", { cache: "no-store" }).then((response) => response.json());
    }
    const [plugins, config] = await Promise.all([pluginsPromise, ensureConfig()]);
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
      if (demo) return demoClipboard.filter(item=>(!query || item.content.toLowerCase().includes(query)) && (!request.kind || request.kind==="all" || item.kind===request.kind)).slice(Number(request.offset)||0,(Number(request.offset)||0)+limit).map(record=>({...record,pluginId:id}));
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
      return pages.search(query, limit, Number(request.offset) || 0)
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
    if (demo) return {ok:false,preview:true,readonly:true,reason:"演示模式仅供查看，不能执行操作"};
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
    async saveConfig() {
      return { ok: false, preview: true, readonly: true, reason: "浏览器预览不能修改配置" };
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
    async listConfigHistory() {
      return { entries: [], limit: 0, directory: "", available: false };
    },
    async previewConfigHistory() {
      throw new Error("浏览器预览不支持配置历史");
    },
    async restoreConfigHistory() {
      throw new Error("浏览器预览不能修改配置");
    },
    async exportConfig() {
      throw new Error("浏览器预览不支持导出配置");
    },
    async pickConfigImport() {
      throw new Error("浏览器预览不支持导入配置");
    },
    async pickWebImport() {
      throw new Error("浏览器预览不支持导入网页目录");
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
    async downloadAndInstallUpdate() {
      return { ok: false, preview: true, reason: "浏览器预览不能安装应用更新" };
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
