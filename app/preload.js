// preload: 安全地暴露能力给渲染层（contextIsolation）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("weborg", {
  getConfig: (query) => ipcRenderer.invoke("weborg:get-config", query || ""),
  openSettings: () => ipcRenderer.invoke("weborg:open-settings"),
  openAccessibilitySettings: () => ipcRenderer.invoke("weborg:open-accessibility-settings"),
  saveConfig: (config) => ipcRenderer.invoke("weborg:save-config", config),
  searchApps: (query) => ipcRenderer.invoke("weborg:search-apps", query || ""),
  searchUsage: (scope) => ipcRenderer.invoke("weborg:search-usage", scope || "all"),
  searchClipboard: (query, kind, limit, offset) => ipcRenderer.invoke("weborg:search-clipboard", query || "", kind || "all", limit || 30, offset || 0),
  copyClipboard: (id) => ipcRenderer.invoke("weborg:copy-clipboard", id),
  showClipboardMenu: (id) => ipcRenderer.invoke("weborg:show-clipboard-menu", id),
  deleteClipboard: (id) => ipcRenderer.invoke("weborg:delete-clipboard", id),
  openUrl: (url, usage) => ipcRenderer.invoke("weborg:open-url", url, usage || {}),
  openLocal: (action, usage) => ipcRenderer.invoke("weborg:open-local", action, usage || {}),
  onConfig: (cb) => {
    ipcRenderer.on("weborg:config", (e, cfg, query) => cb(cfg, query));
  },
  onClipboardUpdated: (cb) => {
    ipcRenderer.on("weborg:clipboard-updated", () => cb());
  },
  onUsageUpdated: (cb) => {
    ipcRenderer.on("weborg:usage-updated", () => cb());
  }
});
