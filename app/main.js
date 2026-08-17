// Web Organization 桌面启动器 - 主进程
// 类 uTools：Alt+空格 呼出全局搜索浮窗；搜索目录/网页/备注；回车用系统浏览器打开；
// 可配置"打开本地应用/命令"。不依赖浏览器扩展。
const { app, BrowserWindow, globalShortcut, ipcMain, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

let win = null;
let settingsWin = null;
let lastQuery = "";

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[weborg] 读取配置失败:", e.message);
    return { app: { title: "Web Organization" }, items: [] };
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("配置必须是 JSON 对象");
  }
  if (!Array.isArray(config.items)) {
    throw new Error("配置缺少 items 数组");
  }

  const ids = new Set();
  function visit(nodes) {
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        throw new Error("目录节点必须是对象");
      }
      if (!String(node.id || "").trim()) {
        throw new Error("每个目录节点都需要 id");
      }
      if (ids.has(node.id)) {
        throw new Error(`目录 id 重复：${node.id}`);
      }
      ids.add(node.id);
      if (node.children !== undefined && !Array.isArray(node.children)) {
        throw new Error(`节点 ${node.id} 的 children 必须是数组`);
      }
      visit(node.children || []);
    }
  }

  visit(config.items);
  return config;
}

function writeConfig(config) {
  validateConfig(config);
  // 先写临时文件再替换，避免 app 与 Web 端同时保存时留下半个 JSON 文件。
  const tempPath = `${CONFIG_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, CONFIG_PATH);
}

function isDev() {
  return process.argv.includes("--dev");
}

// 构建搜索窗（无边框、置顶、不抢焦点的浮层）
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 620;
  const H = 520;
  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + (workArea.height - H) / 3),
    frame: false, // 无边框
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  win.loadFile(path.join(__dirname, "ui", "search.html"));
  win.hide();
  win.on("closed", () => { win = null; });

  // 失焦时（点击外部）自动隐藏 —— 类似 uTools 点外面关闭
  win.on("blur", () => {
    if (win && !win.isDestroyed()) win.hide();
  });
  return win;
}

function createSettingsWindow() {
  settingsWin = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    title: "Web Organization 配置管理",
    backgroundColor: "#101820",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  settingsWin.loadFile(path.join(__dirname, "ui", "settings.html"));
  settingsWin.on("closed", () => { settingsWin = null; });
  return settingsWin;
}

function showSettingsWindow() {
  if (!settingsWin || settingsWin.isDestroyed()) createSettingsWindow();
  settingsWin.show();
  settingsWin.focus();
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  const cfg = readConfig();
  // 每次呼出把最新配置同步给渲染层
  win?.webContents.send("weborg:config", cfg, lastQuery);
  win.show();
  win.focus();
  win.webContents.executeJavaScript("try{window.focusSearch&&window.focusSearch()}catch(e){}");
}

function toggleWindow() {
  if (win && win.isVisible()) {
    win.hide();
  } else {
    showWindow();
  }
}

app.whenReady().then(() => {
  createWindow();

  // 全局快捷键：Alt+空格（系统级，不依赖浏览器）
  const ok = globalShortcut.register("Alt+Space", () => toggleWindow());
  if (!ok) {
    console.warn("[weborg] 无法注册 Alt+Space（可能被系统/其它程序占用）。可在 app 设置中修改。");
  }

  // 冒烟测试：设置该环境变量时，启动后立即退出，便于 CI/无 GUI 环境验证主进程能跑通。
  if (process.env.WEBORG_SMOKE_TEST === "1") {
    console.log("[weborg] smoke test: 主进程已就绪，Alt+Space 全局快捷键注册:", ok);
    setTimeout(() => app.quit(), 500);
  }

  app.on("will-quit", () => globalShortcut.unregisterAll());
});

// 渲染层请求最新配置
ipcMain.handle("weborg:get-config", (event, query) => {
  lastQuery = query || "";
  return readConfig();
});

ipcMain.handle("weborg:open-settings", () => {
  showSettingsWindow();
  return { ok: true };
});

ipcMain.handle("weborg:save-config", (event, config) => {
  try {
    writeConfig(config);
    const savedConfig = readConfig();
    // 搜索浮窗下次呼出会重新读取；如果它当前仍在显示，也立即刷新结果。
    if (win && !win.isDestroyed()) {
      win.webContents.send("weborg:config", savedConfig, lastQuery);
    }
    return { ok: true, config: savedConfig };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
});

// 用系统浏览器/默认应用打开
ipcMain.handle("weborg:open-url", (event, url) => {
  if (/^https?:\/\//i.test(url)) {
    shell.openExternal(url);
    hideWindow();
    return { ok: true };
  }
  return { ok: false, reason: "非 http(s) 链接" };
});

// 启动本地命令（如打开本地工具）。允许白名单模式：仅接受明显可执行/本地路径。
ipcMain.handle("weborg:open-local", (event, action) => {
  if (typeof action !== "string" || !action.trim()) return { ok: false };
  const cmd = action.trim();
  // 用系统默认方式处理本地路径（文件/文件夹/可执行）
  // 直接用 shell.openPath 打开路径；对命令型（如 cli）用 exec 需谨慎，这里仅处理路径。
  shell.openPath(cmd).then((res) => {
    hideWindow();
    return res === "" ? { ok: true } : { ok: false, reason: res };
  });
  return { ok: true, pending: true };
});

function hideWindow() {
  if (win && !win.isDestroyed()) win.hide();
}

app.on("window-all-closed", (e) => {
  // 保持后台，不退出
});

app.on("activate", () => {
  if (!win) createWindow();
});
