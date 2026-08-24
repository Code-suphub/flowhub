// preload: 安全地暴露能力给渲染层（contextIsolation）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("weborg", {
  getConfig: (query) => ipcRenderer.invoke("weborg:get-config", query || ""),
  openSettings: () => ipcRenderer.invoke("weborg:open-settings"),
  openAccessibilitySettings: () => ipcRenderer.invoke("weborg:open-accessibility-settings"),
  getConfigPathInfo: () => ipcRenderer.invoke("weborg:get-config-path-info"),
  chooseConfigPath: () => ipcRenderer.invoke("weborg:choose-config-path"),
  openConfigPath: () => ipcRenderer.invoke("weborg:open-config-path"),
  getClipboardStorageInfo: () => ipcRenderer.invoke("weborg:get-clipboard-storage-info"),
  chooseClipboardStorage: () => ipcRenderer.invoke("weborg:choose-clipboard-storage"),
  openClipboardStorage: () => ipcRenderer.invoke("weborg:open-clipboard-storage"),
  saveConfig: (config) => ipcRenderer.invoke("weborg:save-config", config),
  listPlugins: () => ipcRenderer.invoke("weborg:list-plugins"),
  pluginSearch: (id, request) => ipcRenderer.invoke("weborg:plugin-search", id, request || {}),
  pluginAction: (id, action, payload) => ipcRenderer.invoke("weborg:plugin-action", id, action, payload || {}),
  searchUsage: (scope) => ipcRenderer.invoke("weborg:search-usage", scope || "all"),
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
