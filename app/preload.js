// preload: 安全地暴露能力给渲染层（contextIsolation）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("weborg", {
  getConfig: (query) => ipcRenderer.invoke("weborg:get-config", query || ""),
  openSettings: () => ipcRenderer.invoke("weborg:open-settings"),
  openAccessibilitySettings: () => ipcRenderer.invoke("weborg:open-accessibility-settings"),
  saveConfig: (config) => ipcRenderer.invoke("weborg:save-config", config),
  searchApps: (query) => ipcRenderer.invoke("weborg:search-apps", query || ""),
  searchClipboard: (query) => ipcRenderer.invoke("weborg:search-clipboard", query || ""),
  copyClipboard: (id) => ipcRenderer.invoke("weborg:copy-clipboard", id),
  showClipboardMenu: (id) => ipcRenderer.invoke("weborg:show-clipboard-menu", id),
  deleteClipboard: (id) => ipcRenderer.invoke("weborg:delete-clipboard", id),
  openUrl: (url) => ipcRenderer.invoke("weborg:open-url", url),
  openLocal: (action) => ipcRenderer.invoke("weborg:open-local", action),
  onConfig: (cb) => {
    ipcRenderer.on("weborg:config", (e, cfg, query) => cb(cfg, query));
  },
  onClipboardUpdated: (cb) => {
    ipcRenderer.on("weborg:clipboard-updated", () => cb());
  }
});
