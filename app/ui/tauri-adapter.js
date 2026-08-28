// Tauri 迁移层：保留现有页面和 window.weborg 接口，只替换原生能力的实现。
// 这样 Electron 版仍可继续发布，Tauri 版可以独立验证体积和行为。
if (!window.weborg && window.__TAURI__?.core?.invoke) {
  document.documentElement.dataset.weborgRuntime = "tauri";
  document.documentElement.dataset.weborgPage = location.pathname.includes("settings") ? "settings" : "search";
  const runtimeMode = document.getElementById("runtimeMode");
  if (runtimeMode) runtimeMode.textContent = "Tauri 迁移版 · FlowHub";

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const configListeners = new Set();
  const clipboardListeners = new Set();
  const usageListeners = new Set();
  const updateListeners = new Set();
  let configCache = null;
  let pluginsPromise = null;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function flattenPages(nodes, path = []) {
    return (nodes || []).flatMap((node) => {
      const nextPath = [...path, { id: node.id, title: node.title, icon: node.icon || "" }];
      const current = node.url ? [{ ...node, type: "page", path: nextPath, breadcrumb: nextPath.map((entry) => entry.title).join(" / ") }] : [];
      return [...current, ...flattenPages(node.children || [], nextPath)];
    });
  }

  async function getConfig() {
    if (!configCache) configCache = await invoke("get_config");
    return clone(configCache);
  }

  async function listPlugins() {
    if (!pluginsPromise) pluginsPromise = fetch("/plugins.json", { cache: "no-store" }).then((response) => response.json());
    const [plugins, config] = await Promise.all([pluginsPromise, getConfig()]);
    return plugins.map((plugin) => ({
      ...plugin,
      available: ["web", "app", "memo"].includes(plugin.id),
      enabled: config.plugins?.[plugin.id]?.enabled ?? plugin.defaultEnabled !== false
    }));
  }

  async function pluginSearch(id, request = {}) {
    const plugin = (await listPlugins()).find((entry) => entry.id === id);
    if (!plugin?.available) throw new Error(`Tauri 迁移版暂未迁移插件：${id}`);
    if (!plugin.enabled) throw new Error(`插件未启用：${id}`);
    const query = String(request.query || "").trim();
    const limit = Math.max(1, Number(request.limit) || 12);
    const offset = Math.max(0, Number(request.offset) || 0);
    if (id === "app") {
      return (await invoke("search_applications", { query, limit, offset })).map((record) => ({ ...record, pluginId: id }));
    }
    if (id === "web") {
      const pages = flattenPages((await getConfig()).plugins?.web?.settings?.items || []);
      return window.FlowHubWebSearch.rankWebPages(pages, query, limit, offset)
        .map((record) => ({ ...record, pluginId: id }));
    }
    if (id === "memo") {
      const config = await getConfig();
      const configuredItems = config.plugins?.memo?.settings?.items;
      const items = Array.isArray(configuredItems) ? configuredItems : window.FlowHubMemoCatalog.cloneDefaults();
      return window.FlowHubMemoCatalog.rankMemos(items, query, limit, offset)
        .map((record) => ({ ...record, pluginId: id }));
    }
    return [];
  }

  async function pluginAction(id, action, payload = {}) {
    if (action !== "activate") return { ok: false, reason: `插件 ${id} 不支持操作 ${action}` };
    const result = await invoke("activate_target", { pluginId: id, payload });
    if (result?.ok && ["app", "web"].includes(id)) usageListeners.forEach((listener) => listener());
    return result;
  }

  const unsupportedUpdate = () => ({
    supported: false,
    currentVersion: "0.1.0",
    status: "unsupported",
    availableVersion: "",
    percent: 0,
    error: "Tauri 对比版本暂未接入自动更新"
  });

  window.weborg = {
    getConfig,
    async saveConfig(config) {
      const result = await invoke("save_config", { config });
      if (result?.ok && result.config) {
        configCache = clone(result.config);
        configListeners.forEach((listener) => listener(clone(configCache)));
      }
      return result;
    },
    listPlugins,
    pluginSearch,
    pluginAction,
    searchUsage: (scope = "all") => invoke("search_usage", { scope }),
    openSettings: () => invoke("open_settings"),
    openAccessibilitySettings: () => invoke("open_accessibility_settings"),
    getConfigPathInfo: () => invoke("get_config_path_info"),
    chooseConfigPath: async () => ({ ok: false, reason: "Tauri 对比版本暂不支持切换配置文件位置" }),
    openConfigPath: () => invoke("open_config_path"),
    getClipboardStorageInfo: () => invoke("get_storage_info"),
    chooseClipboardStorage: async () => ({ ok: false, reason: "Tauri 对比版本使用独立的数据副本，暂不支持切换存放位置" }),
    openClipboardStorage: () => invoke("open_storage_path"),
    getUpdateState: async () => unsupportedUpdate(),
    checkForUpdates: async () => ({ ok: false, reason: "Tauri 对比版本暂未接入自动更新", state: unsupportedUpdate() }),
    downloadUpdate: async () => ({ ok: false, reason: "Tauri 对比版本暂未接入自动更新", state: unsupportedUpdate() }),
    quitAndInstallUpdate: async () => ({ ok: false, reason: "Tauri 对比版本暂未接入自动更新", state: unsupportedUpdate() }),
    onConfig(listener) { configListeners.add(listener); return () => configListeners.delete(listener); },
    onClipboardUpdated(listener) { clipboardListeners.add(listener); return () => clipboardListeners.delete(listener); },
    onUsageUpdated(listener) { usageListeners.add(listener); return () => usageListeners.delete(listener); },
    onUpdateState(listener) { updateListeners.add(listener); return () => updateListeners.delete(listener); }
  };

  void listen("flowhub:config", (event) => {
    const next = event.payload?.config || event.payload;
    if (!next) return;
    configCache = clone(next);
    configListeners.forEach((listener) => listener(clone(configCache), event.payload?.query || ""));
  });
  void listen("flowhub:usage-updated", () => usageListeners.forEach((listener) => listener()));
}
