// preload: 安全地暴露能力给渲染层（contextIsolation）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("weborg", {
  getConfig: (query) => ipcRenderer.invoke("weborg:get-config", query || ""),
  openSettings: () => ipcRenderer.invoke("weborg:open-settings"),
  saveConfig: (config) => ipcRenderer.invoke("weborg:save-config", config),
  openUrl: (url) => ipcRenderer.invoke("weborg:open-url", url),
  openLocal: (action) => ipcRenderer.invoke("weborg:open-local", action),
  onConfig: (cb) => {
    ipcRenderer.on("weborg:config", (e, cfg, query) => cb(cfg, query));
  }
});
