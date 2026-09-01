// Tauri 适配层：保留现有页面和 window.weborg 接口，替换原生能力的实现。
if (!window.weborg && window.__TAURI__?.core?.invoke) {
  document.documentElement.dataset.weborgRuntime = "tauri";
  document.documentElement.dataset.weborgPage = location.pathname.includes("settings") ? "settings" : "search";
  const runtimeMode = document.getElementById("runtimeMode");
  if (runtimeMode) runtimeMode.textContent = "FlowHub";

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const configListeners = new Set();
  const clipboardListeners = new Set();
  const usageListeners = new Set();
  const updateListeners = new Set();
  let configCache = null;
  let webPageIndex = null;
  let pluginsPromise = null;
  const applicationIconCache = new Map();
  const applicationIconInflight = new Map();

  function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function flattenPages(nodes, path = []) {
    return (nodes || []).flatMap((node) => {
      const nextPath = [...path, { id: node.id, title: node.title, icon: node.icon || "" }];
      const current = node.url ? [{ ...node, type: "page", path: nextPath, breadcrumb: nextPath.map((entry) => entry.title).join(" / ") }] : [];
      return [...current, ...flattenPages(node.children || [], nextPath)];
    });
  }

  async function ensureConfig() {
    if (!configCache) configCache = await invoke("get_config");
    return configCache;
  }

  async function getConfig() {
    return cloneValue(await ensureConfig());
  }

  async function indexedWebPages() {
    if (!webPageIndex) {
      const config = await ensureConfig();
      webPageIndex = flattenPages(config.plugins?.web?.settings?.items || []);
    }
    return webPageIndex;
  }

  async function listPlugins() {
    if (!pluginsPromise) pluginsPromise = fetch("/plugins.json", { cache: "no-store" }).then((response) => response.json());
    const [plugins, config] = await Promise.all([pluginsPromise, ensureConfig()]);
    return plugins.map((plugin) => ({
      ...plugin,
      available: ["web", "clipboard", "app", "memo", "tools"].includes(plugin.id),
      enabled: config.plugins?.[plugin.id]?.enabled ?? plugin.defaultEnabled !== false
    }));
  }

  async function pluginSearch(id, request = {}) {
    const plugin = (await listPlugins()).find((entry) => entry.id === id);
    if (!plugin?.available) throw new Error(`当前版本暂不支持插件：${id}`);
    if (!plugin.enabled) throw new Error(`插件未启用：${id}`);
    const query = String(request.query || "").trim();
    const limit = Math.max(1, Number(request.limit) || 12);
    const offset = Math.max(0, Number(request.offset) || 0);
    if (id === "clipboard") {
      return invoke("search_clipboard", { query, kind: request.kind || "all", limit, offset });
    }
    if (id === "app") {
      return (await invoke("search_applications", { query, limit, offset, includeIcons: request.includeIcons !== false })).map((record) => ({ ...record, pluginId: id }));
    }
    if (id === "web") {
      const pages = await indexedWebPages();
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

  async function loadAppIcons(paths = []) {
    const uniquePaths = [...new Set((paths || []).filter(Boolean))];
    if (!uniquePaths.length) return {};
    const missingPaths = uniquePaths.filter((path) => !applicationIconCache.has(path) && !applicationIconInflight.has(path));
    if (missingPaths.length) {
      const request = invoke("load_application_icons", { paths: missingPaths }).catch(() => ({}));
      for (const path of missingPaths) {
        const pending = request
          .then((icons) => {
            const icon = icons?.[path] || "";
            if (icon) applicationIconCache.set(path, icon);
            return icon;
          })
          .finally(() => {
            if (applicationIconInflight.get(path) === pending) applicationIconInflight.delete(path);
          });
        applicationIconInflight.set(path, pending);
      }
    }
    const entries = await Promise.all(uniquePaths.map(async (path) => [path, applicationIconCache.get(path) || await applicationIconInflight.get(path) || ""]));
    return Object.fromEntries(entries.filter(([, icon]) => icon));
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
    let geo = {};
    try {
      const response = await fetch("https://ipapi.co/json/", { cache: "no-store" });
      if (response.ok) geo = await response.json();
    } catch {}
    const readIp = async (endpoint) => {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("IP endpoint unavailable");
      const text = (await response.text()).trim();
      try { return JSON.parse(text).ip || ""; } catch { return text; }
    };
    const [ipv4, ipv6] = await Promise.allSettled([readIp("https://api4.ipify.org?format=json"), readIp("https://api6.ipify.org?format=json")]);
    if (ipv4.status === "fulfilled" || ipv6.status === "fulfilled") {
      return { ...geo, ipv4: ipv4.status === "fulfilled" ? ipv4.value : "", ipv6: ipv6.status === "fulfilled" ? ipv6.value : "" };
    }
    for (const endpoint of ["https://ifconfig.me/ip", "https://icanhazip.com", "https://api.ipify.org?format=json", "https://api64.ipify.org?format=json"]) {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) continue;
        const text = (await response.text()).trim();
        try { return { ...geo, ipv4: JSON.parse(text).ip || "" }; } catch { return { ...geo, ipv4: text }; }
      } catch {}
    }
    throw new Error("本机 IP 查询失败");
  }

  function normalizeIpLocation(body) {
    return {
      ip: body?.ip || "",
      version: body?.version || body?.type || "",
      city: body?.city || "",
      region: body?.region || "",
      country_name: body?.country_name || body?.country || "",
      org: body?.org || body?.connection?.org || body?.connection?.isp || "",
      asn: body?.asn || body?.connection?.asn || "",
      timezone: typeof body?.timezone === "string" ? body.timezone : body?.timezone?.id || ""
    };
  }

  async function lookupIp(ip) {
    const address = String(ip || "").trim();
    if (!address) throw new Error("IP 地址为空");
    const encoded = encodeURIComponent(address);
    const providers = [
      `https://ipwho.is/${encoded}`,
      `https://ipapi.co/${encoded}/json/`
    ];
    let lastError = "IP 查询失败";
    for (const endpoint of providers) {
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(6000) });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body?.error || body?.success === false) {
          lastError = body?.reason || body?.message || `IP 查询失败：${response.status}`;
          continue;
        }
        return normalizeIpLocation(body);
      } catch (error) {
        lastError = error?.message || lastError;
      }
    }
    throw new Error(lastError);
  }

  async function inspectCloudflare(hostname) {
    const value = String(hostname || "").trim();
    if (!value) throw new Error("域名为空");
    const response = await fetch(`https://${value}/`, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(6000)
    });
    const headers = Object.fromEntries([...response.headers.entries()].map(([key, item]) => [key.toLowerCase(), item]));
    const evidence = [];
    if (headers.server?.toLowerCase().includes("cloudflare")) evidence.push("server: cloudflare");
    if (headers["cf-ray"]) evidence.push("cf-ray");
    if (headers["cf-cache-status"]) evidence.push("cf-cache-status");
    if (headers["cf-mitigated"]) evidence.push(`cf-mitigated: ${headers["cf-mitigated"]}`);
    const cloudflare = evidence.length > 0;
    const challenge = Boolean(headers["cf-mitigated"]) || (cloudflare && [403, 429].includes(response.status));
    response.body?.cancel?.();
    return { status: response.status, cloudflare, challenge, evidence };
  }

  async function lookupProxy() {
    const config = await getConfig();
    const adapter = config?.plugins?.tools?.settings?.proxyAdapter || "auto";
    const details = await invoke("get_proxy_info", { adapter });
    try {
      const ip = await lookupLocalIp();
      return { ...details, egressIp: ip?.ipv4 || ip?.ipv6 || "" };
    } catch {
      return details;
    }
  }

  async function pluginAction(id, action, payload = {}) {
    if (id === "clipboard" && action === "activate") return invoke("activate_clipboard", { id: Number(payload.id) });
    if (id === "clipboard" && ["menu", "delete"].includes(action)) {
      if (!window.confirm("确定删除这条剪贴板记录吗？只会删除历史记录和图片副本，不会删除原始文件。")) {
        return { ok: false, cancelled: true };
      }
      return invoke("delete_clipboard", { id: Number(payload.id) });
    }
    if (action !== "activate") return { ok: false, reason: `插件 ${id} 不支持操作 ${action}` };
    const result = await invoke("activate_target", { pluginId: id, payload });
    if (result?.ok && ["app", "web"].includes(id)) usageListeners.forEach((listener) => listener());
    return result;
  }

  window.weborg = {
    getConfig,
    async saveConfig(config) {
      const result = await invoke("save_config", { config });
      if (result?.ok && result.config) {
        configCache = cloneValue(result.config);
        webPageIndex = null;
        configListeners.forEach((listener) => listener(cloneValue(configCache)));
      }
      return result;
    },
    listPlugins,
    pluginSearch,
    loadAppIcons,
    loadClipboardAssets: (ids = []) => invoke("load_clipboard_assets", { ids }),
    lookupDns,
    lookupLocalIp,
    lookupIp,
    inspectCloudflare,
    lookupProxy,
    pluginAction,
    hideMain: () => invoke("hide_main_window"),
    searchUsage: (scope = "all") => invoke("search_usage", { scope }),
    openSettings: (options = {}) => invoke("open_settings", { initialUrl: options.initialUrl || null }),
    openAccessibilitySettings: () => invoke("open_accessibility_settings"),
    getConfigPathInfo: () => invoke("get_config_path_info"),
    chooseConfigPath: () => invoke("choose_config_path"),
    openConfigPath: () => invoke("open_config_path"),
    getClipboardStorageInfo: () => invoke("get_storage_info"),
    chooseClipboardStorage: () => invoke("choose_storage_path"),
    openClipboardStorage: () => invoke("open_storage_path"),
    getUpdateState: () => invoke("get_update_state"),
    checkForUpdates: () => invoke("check_for_updates"),
    downloadUpdate: () => invoke("download_update"),
    quitAndInstallUpdate: () => invoke("quit_and_install_update"),
    onConfig(listener) { configListeners.add(listener); return () => configListeners.delete(listener); },
    onClipboardUpdated(listener) { clipboardListeners.add(listener); return () => clipboardListeners.delete(listener); },
    onUsageUpdated(listener) { usageListeners.add(listener); return () => usageListeners.delete(listener); },
    onUpdateState(listener) { updateListeners.add(listener); return () => updateListeners.delete(listener); }
  };

  void listen("flowhub:config", (event) => {
    const next = event.payload?.config || event.payload;
    if (!next) return;
    configCache = cloneValue(next);
    webPageIndex = null;
    configListeners.forEach((listener) => listener(cloneValue(configCache), event.payload?.query || ""));
  });
  void listen("flowhub:usage-updated", () => usageListeners.forEach((listener) => listener()));
  void listen("flowhub:clipboard-updated", () => clipboardListeners.forEach((listener) => listener()));
  void listen("flowhub:update-state", (event) => updateListeners.forEach((listener) => listener(event.payload)));
}
