// Shared by the legacy extension, HTTP server and CLI. Desktop config is not
// a legacy catalog, even when its SQLite items have already been hydrated.
(() => {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  function validate(config) {
    if (object(config) && ("plugins" in config || "core" in config)) {
      throw new Error("旧版 Web/扩展仅支持顶层 items 目录；桌面 plugins.web.settings.items 不受支持。SQLite 配置中的 items 可能尚未水合，不能视为空目录；请使用桌面应用管理目录，或显式提供独立的旧版 JSON 目录副本。");
    }
    if (!object(config) || config.ok === false || !Array.isArray(config.items)) {
      throw new Error("无效旧版目录：需要包含顶层 items 数组的 JSON 对象");
    }
    const pending = [...config.items];
    while (pending.length) {
      const node = pending.pop();
      if (!object(node) || (node.children !== undefined && !Array.isArray(node.children))) {
        throw new Error("无效旧版目录：items/children 必须是节点对象数组");
      }
      if (node.children) for (const child of node.children) pending.push(child);
    }
    return config;
  }

  async function readSources(sources, fetcher = globalThis.fetch) {
    let lastError;
    for (const source of sources) {
      let response;
      try { response = await fetcher(source, { cache: "no-store" }); }
      catch (error) { lastError = error; continue; }
      // A reachable source is authoritative. Never hide bad data behind the
      // bundled example or publish a synthetic empty catalog to the cache.
      const config = await response.json();
      if (!response.ok) throw new Error(config?.reason || `读取目录失败：HTTP ${response.status}`);
      return validate(config);
    }
    throw new Error(`读取目录失败：${lastError?.message || "无可用来源"}`);
  }
  globalThis.FlowHubLegacyCatalog = Object.freeze({ validate, readSources });
})();
