const UPDATE_STATUSES = new Set([
  "unsupported",
  "idle",
  "checking",
  "available",
  "not-available",
  "downloading",
  "downloaded",
  "installing",
  "error"
]);

function releaseNotesText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => String(entry?.note || "").trim()).filter(Boolean).join("\n\n");
}

function publicError(error) {
  const message = String(error?.message || error || "更新操作失败").trim();
  return message.replace(/https?:\/\/\S+/g, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "远程更新服务";
    }
  });
}

function createUpdateService({ app, autoUpdater, broadcast = () => {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  let initialized = false;
  let initialCheckTimer = null;
  let activeCheck = null;
  let activeDownload = null;
  const supported = Boolean(app?.isPackaged && autoUpdater);
  let state = {
    supported,
    currentVersion: String(app?.getVersion?.() || "0.0.0"),
    status: supported ? "idle" : "unsupported",
    availableVersion: "",
    releaseDate: "",
    releaseNotes: "",
    percent: 0,
    bytesPerSecond: 0,
    transferred: 0,
    total: 0,
    checkedAt: "",
    error: ""
  };

  const snapshot = () => ({ ...state });

  function update(patch) {
    const nextStatus = patch.status || state.status;
    if (!UPDATE_STATUSES.has(nextStatus)) throw new Error(`未知更新状态：${nextStatus}`);
    state = { ...state, ...patch, status: nextStatus };
    broadcast(snapshot());
    return snapshot();
  }

  function updateInfo(info = {}) {
    return {
      availableVersion: String(info.version || ""),
      releaseDate: String(info.releaseDate || ""),
      releaseNotes: releaseNotesText(info.releaseNotes)
    };
  }

  function initialize() {
    if (initialized || !supported) return snapshot();
    initialized = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
      info: (...args) => console.log("[flowhub][updater]", ...args),
      warn: (...args) => console.warn("[flowhub][updater]", ...args),
      error: (...args) => console.error("[flowhub][updater]", ...args),
      debug: (...args) => console.debug("[flowhub][updater]", ...args)
    };

    autoUpdater.on("checking-for-update", () => update({ status: "checking", error: "", percent: 0 }));
    autoUpdater.on("update-available", (info) => update({
      status: "available",
      ...updateInfo(info),
      checkedAt: new Date().toISOString(),
      error: "",
      percent: 0
    }));
    autoUpdater.on("update-not-available", (info) => update({
      status: "not-available",
      ...updateInfo(info),
      availableVersion: "",
      checkedAt: new Date().toISOString(),
      error: "",
      percent: 0
    }));
    autoUpdater.on("download-progress", (progress = {}) => update({
      status: "downloading",
      percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
      bytesPerSecond: Math.max(0, Number(progress.bytesPerSecond) || 0),
      transferred: Math.max(0, Number(progress.transferred) || 0),
      total: Math.max(0, Number(progress.total) || 0),
      error: ""
    }));
    autoUpdater.on("update-downloaded", (info) => update({
      status: "downloaded",
      ...updateInfo(info),
      percent: 100,
      error: ""
    }));
    autoUpdater.on("update-cancelled", () => update({ status: "available", percent: 0, error: "更新下载已取消" }));
    autoUpdater.on("error", (error) => update({ status: "error", error: publicError(error) }));
    return snapshot();
  }

  async function checkForUpdates() {
    if (!supported) return { ok: false, reason: "开发模式不检查应用更新", state: snapshot() };
    initialize();
    if (activeCheck) return activeCheck;
    if (["downloading", "downloaded", "installing"].includes(state.status)) {
      return { ok: false, reason: "当前更新流程尚未完成", state: snapshot() };
    }
    update({ status: "checking", error: "", percent: 0 });
    activeCheck = autoUpdater.checkForUpdates()
      .then(() => ({ ok: true, state: snapshot() }))
      .catch((error) => {
        update({ status: "error", error: publicError(error) });
        return { ok: false, reason: publicError(error), state: snapshot() };
      })
      .finally(() => { activeCheck = null; });
    return activeCheck;
  }

  async function downloadUpdate() {
    if (!supported) return { ok: false, reason: "开发模式不能下载应用更新", state: snapshot() };
    initialize();
    if (activeDownload) return activeDownload;
    if (state.status !== "available") return { ok: false, reason: "当前没有可下载的新版本", state: snapshot() };
    update({ status: "downloading", error: "", percent: 0 });
    activeDownload = autoUpdater.downloadUpdate()
      .then(() => ({ ok: true, state: snapshot() }))
      .catch((error) => {
        update({ status: "error", error: publicError(error) });
        return { ok: false, reason: publicError(error), state: snapshot() };
      })
      .finally(() => { activeDownload = null; });
    return activeDownload;
  }

  function quitAndInstall() {
    if (!supported) return { ok: false, reason: "开发模式不能安装应用更新", state: snapshot() };
    if (state.status !== "downloaded") return { ok: false, reason: "更新尚未下载完成", state: snapshot() };
    update({ status: "installing", error: "" });
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true, state: snapshot() };
  }

  function scheduleInitialCheck(delay = 5000) {
    if (!supported || initialCheckTimer) return false;
    initialize();
    initialCheckTimer = setTimeoutFn(() => {
      initialCheckTimer = null;
      void checkForUpdates();
    }, Math.max(0, Number(delay) || 0));
    return true;
  }

  function dispose() {
    if (initialCheckTimer) clearTimeoutFn(initialCheckTimer);
    initialCheckTimer = null;
  }

  return {
    initialize,
    getState: snapshot,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    scheduleInitialCheck,
    dispose
  };
}

module.exports = { createUpdateService, publicError, releaseNotesText };
