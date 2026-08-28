const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdateService, publicError, releaseNotesText } = require("../update-service");

class MockUpdater extends EventEmitter {
  constructor() {
    super();
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.installCalls = [];
  }

  async checkForUpdates() {
    this.checkCalls += 1;
    this.emit("checking-for-update");
    this.emit("update-available", { version: "0.2.0", releaseDate: "2026-08-28", releaseNotes: "新增自动更新" });
    return {};
  }

  async downloadUpdate() {
    this.downloadCalls += 1;
    this.emit("download-progress", { percent: 42.5, bytesPerSecond: 2048, transferred: 425, total: 1000 });
    this.emit("update-downloaded", { version: "0.2.0" });
    return ["/tmp/FlowHub.zip"];
  }

  quitAndInstall(...args) {
    this.installCalls.push(args);
  }
}

test("开发模式明确标记为不支持更新", async () => {
  const service = createUpdateService({
    app: { isPackaged: false, getVersion: () => "0.1.0" },
    autoUpdater: new MockUpdater()
  });
  assert.deepEqual(service.getState(), {
    supported: false,
    currentVersion: "0.1.0",
    status: "unsupported",
    availableVersion: "",
    releaseDate: "",
    releaseNotes: "",
    percent: 0,
    bytesPerSecond: 0,
    transferred: 0,
    total: 0,
    checkedAt: "",
    error: ""
  });
  assert.equal((await service.checkForUpdates()).ok, false);
});

test("检查、下载和安装更新按状态推进", async () => {
  const updater = new MockUpdater();
  const states = [];
  const service = createUpdateService({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    autoUpdater: updater,
    broadcast: (state) => states.push(state)
  });

  assert.equal((await service.checkForUpdates()).ok, true);
  assert.equal(service.getState().status, "available");
  assert.equal(service.getState().availableVersion, "0.2.0");
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);

  assert.equal((await service.downloadUpdate()).ok, true);
  assert.equal(service.getState().status, "downloaded");
  assert.equal(service.getState().percent, 100);
  assert.ok(states.some((state) => state.status === "downloading" && state.percent === 42.5));

  assert.equal(service.quitAndInstall().ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updater.installCalls, [[false, true]]);
});

test("启动检查只安排一次", () => {
  let callback = null;
  let timerCalls = 0;
  const service = createUpdateService({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    autoUpdater: new MockUpdater(),
    setTimeoutFn: (fn) => { timerCalls += 1; callback = fn; return 1; },
    clearTimeoutFn: () => {}
  });
  assert.equal(service.scheduleInitialCheck(100), true);
  assert.equal(service.scheduleInitialCheck(100), false);
  assert.equal(timerCalls, 1);
  assert.equal(typeof callback, "function");
});

test("发布说明和错误只暴露可展示文本", () => {
  assert.equal(releaseNotesText([{ note: "A" }, { note: "B" }]), "A\n\nB");
  assert.equal(publicError(new Error("请求 https://example.com/feed?token=secret 失败")), "请求 https://example.com/feed 失败");
});
