// Web Organization 桌面启动器 - 主进程
// 类 uTools：Alt+空格 呼出全局搜索浮窗；搜索目录/网页/备注；回车用系统浏览器打开；
// 可配置"打开本地应用/命令"。不依赖浏览器扩展。
const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, nativeImage, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { fileURLToPath, pathToFileURL } = require("url");
const clipboardStore = require("./clipboard-store");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

let win = null;
let settingsWin = null;
let lastQuery = "";
let clipboardTimer = null;
let clipboardPollInFlight = false;
let lastClipboardSignature = "";
let lastClipboardCleanupAt = 0;
let clipboardSettingsCache = null;
let clipboardSettingsMtime = 0;
let lastClipboardText = null;
let lastClipboardTextHash = "";
let lastClipboardImageFormats = "";
let lastClipboardImageCheckAt = 0;
let cachedClipboardImage = null;
let lastClipboardFileData = "";
let cachedClipboardFiles = null;
let blurHideTimer = null;

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
  clipboardSettingsCache = null;
  clipboardSettingsMtime = 0;
}

function clipboardSettings() {
  try {
    const mtime = fs.statSync(CONFIG_PATH).mtimeMs;
    if (clipboardSettingsCache && clipboardSettingsMtime === mtime) return clipboardSettingsCache;
    const config = readConfig();
    clipboardSettingsCache = {
      enabled: config.clipboard?.enabled !== false,
      retentionDays: Number(config.clipboard?.retentionDays ?? 30)
    };
    clipboardSettingsMtime = mtime;
    return clipboardSettingsCache;
  } catch {}
  const config = readConfig();
  return {
    enabled: config.clipboard?.enabled !== false,
    retentionDays: Number(config.clipboard?.retentionDays ?? 30)
  };
}

function hashBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const FILE_CLIPBOARD_FORMATS = [
  "public.file-url",
  "NSFilenamesPboardType",
  "text/uri-list",
  "application/x-file-list"
];
const IMAGE_CLIPBOARD_FORMATS = [
  "public.png",
  "public.tiff",
  "public.jpeg",
  "public.jpg",
  "public.gif",
  "public.bmp",
  "public.heic",
  "public.webp",
  "image/png",
  "image/tiff",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/heic",
  "image/webp"
];

function isImageClipboardFormat(format) {
  return /(^image\/|image|png|jpe?g|gif|tiff)/i.test(String(format || ""));
}

function hasClipboardFormat(format, formats) {
  if (formats.includes(format)) return true;
  try { return clipboard.has(format); } catch { return false; }
}

function readClipboardFormat(format) {
  try {
    const buffer = clipboard.readBuffer(format);
    if (Buffer.isBuffer(buffer) && buffer.length) return buffer;
  } catch {}
  try {
    const value = clipboard.read(format);
    if (value) return Buffer.from(value, "utf8");
  } catch {}
  return Buffer.alloc(0);
}

function filePathFromValue(value) {
  const raw = String(value || "").trim().replace(/^<|>$/g, "");
  if (!raw) return "";
  try {
    if (/^file:/i.test(raw)) return fileURLToPath(new URL(raw));
  } catch {}
  if (path.isAbsolute(raw) || /^[a-z]:[\\/]/i.test(raw)) return raw;
  return "";
}

function parseFileClipboardData(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");
  const xmlValues = [...raw.matchAll(/<string>(.*?)<\/string>/gis)].map((match) => match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'"));
  const values = xmlValues.length
    ? xmlValues
    : raw.includes("file://")
    ? (raw.match(/file:\/\/[^\s\r\n<"]+/gi) || [])
    : raw.split(/\r?\n|\0/);
  return [...new Set(values.map(filePathFromValue).filter(Boolean))];
}

function readFileClipboardPayload(formats) {
  const fileFormats = [...new Set([
    ...FILE_CLIPBOARD_FORMATS,
    ...formats.filter((format) => /uri-list|file-url|filenames|filename/i.test(String(format || "")))
  ])].filter((format) => hasClipboardFormat(format, formats));
  if (!fileFormats.length) {
    lastClipboardFileData = "";
    cachedClipboardFiles = null;
    return null;
  }

  for (const format of fileFormats) {
    const buffer = readClipboardFormat(format);
    const raw = buffer.toString("utf8");
    if (!raw) continue;
    const fileData = `${format}\u0000${raw}`;
    if (fileData === lastClipboardFileData) return cachedClipboardFiles;
    const filePaths = parseFileClipboardData(buffer);
    if (!filePaths.length) continue;
    lastClipboardFileData = fileData;
    cachedClipboardFiles = { kind: "file", value: filePaths, hash: hashBuffer(Buffer.from(filePaths.join("\u0000"), "utf8")) };
    return cachedClipboardFiles;
  }
  lastClipboardFileData = "";
  cachedClipboardFiles = null;
  return null;
}

function readImageClipboardPayload(formats, now) {
  const imageFormats = [...new Set([
    ...formats.filter(isImageClipboardFormat),
    ...IMAGE_CLIPBOARD_FORMATS
  ])].filter((format) => hasClipboardFormat(format, formats)).sort().join("|");
  if (!imageFormats) {
    cachedClipboardImage = null;
    lastClipboardImageFormats = "";
    return null;
  }
  if (imageFormats !== lastClipboardImageFormats || now - lastClipboardImageCheckAt >= 1000) {
    try {
      const image = clipboard.readImage();
      if (image.isEmpty()) {
        cachedClipboardImage = null;
      } else {
        const buffer = image.toPNG();
        cachedClipboardImage = buffer.length
          ? { kind: "image", value: buffer, hash: hashBuffer(buffer) }
          : null;
      }
    } catch {
      cachedClipboardImage = null;
    }
    lastClipboardImageFormats = imageFormats;
    lastClipboardImageCheckAt = now;
  }
  return cachedClipboardImage;
}

function resetClipboardSnapshot() {
  lastClipboardSignature = "";
  lastClipboardText = null;
  lastClipboardTextHash = "";
  lastClipboardImageFormats = "";
  lastClipboardImageCheckAt = 0;
  cachedClipboardImage = null;
  lastClipboardFileData = "";
  cachedClipboardFiles = null;
}

function readClipboardPayloads(now = Date.now()) {
  const payloads = [];
  const formats = clipboard.availableFormats();
  const filePayload = readFileClipboardPayload(formats);
  const imagePayload = readImageClipboardPayload(formats, now);

  const text = clipboard.readText();
  if (text !== lastClipboardText) {
    lastClipboardText = text;
    lastClipboardTextHash = text ? hashBuffer(Buffer.from(text, "utf8")) : "";
  }
  // macOS 的图片剪切板经常同时带有指向临时文件的 file-url；有真实图像数据时优先记录图片，
  // 普通文件则落到 filePayload，避免退化成 readText() 返回的文件名。
  if (imagePayload) payloads.push(imagePayload);
  else if (filePayload) payloads.push(filePayload);
  else if (text && lastClipboardTextHash) payloads.push({ kind: "text", value: text, hash: lastClipboardTextHash });
  return payloads;
}

async function pollClipboard() {
  if (clipboardPollInFlight || !clipboardStore.isReady()) return;
  clipboardPollInFlight = true;
  try {
    const settings = clipboardSettings();
    if (!settings.enabled) {
      resetClipboardSnapshot();
      return;
    }

    const payloads = readClipboardPayloads();
    const signature = payloads.map((payload) => `${payload.kind}:${payload.hash}`).join("|");
    if (signature && signature !== lastClipboardSignature) {
      clipboardStore.addBatch(payloads);
      lastClipboardSignature = signature;
      if (win && !win.isDestroyed()) win.webContents.send("weborg:clipboard-updated");
    } else if (!signature) {
      resetClipboardSnapshot();
    }

    const now = Date.now();
    if (now - lastClipboardCleanupAt > 60 * 1000) {
      clipboardStore.cleanup(settings.retentionDays);
      lastClipboardCleanupAt = now;
    }
  } catch (error) {
    console.error("[weborg] 剪切板读取失败:", error.message);
  } finally {
    clipboardPollInFlight = false;
  }
}

function startClipboardMonitor() {
  if (clipboardTimer || !clipboardStore.isReady()) return;
  clipboardTimer = setInterval(() => { void pollClipboard(); }, 500);
  void pollClipboard();
}

function stopClipboardMonitor() {
  if (clipboardTimer) clearInterval(clipboardTimer);
  clipboardTimer = null;
}

function isDev() {
  return process.argv.includes("--dev");
}

// 构建搜索窗（无边框、置顶、不抢焦点的浮层）
function createWindow() {
  const cursorPoint = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursorPoint);
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
    // macOS 面板可以跨 Spaces，并浮在其他应用的原生全屏窗口上方。
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  if (process.platform === "darwin") {
    // panel 已经具备跨工作区/全屏显示能力，这里只提升窗口层级，不再调用
    // setVisibleOnAllWorkspaces，避免首次唤出时触发 macOS 应用类型切换。
    win.setAlwaysOnTop(true, "pop-up-menu");
  }

  win.loadFile(path.join(__dirname, "ui", "search.html"));
  win.hide();
  win.on("closed", () => {
    if (blurHideTimer) clearTimeout(blurHideTimer);
    blurHideTimer = null;
    win = null;
  });

  win.on("focus", () => {
    if (blurHideTimer) clearTimeout(blurHideTimer);
    blurHideTimer = null;
  });

  // 失焦时（点击外部）自动隐藏。macOS 全屏空间切换可能产生一次短暂 blur，
  // 延迟判断避免首次唤出时被误隐藏。
  win.on("blur", () => {
    if (blurHideTimer) clearTimeout(blurHideTimer);
    blurHideTimer = setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isFocused()) win.hide();
      blurHideTimer = null;
    }, 120);
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
  win.moveTop();
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

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    // 启动器不是普通 Dock 应用；使用 accessory 可避免唤出时切换到应用自己的 Space。
    app.setActivationPolicy("accessory");
  }

  try {
    await clipboardStore.open(app.getPath("userData"));
    startClipboardMonitor();
  } catch (error) {
    console.error("[weborg] 剪切板数据库初始化失败:", error.message);
  }
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

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    stopClipboardMonitor();
    clipboardStore.close();
  });
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
    if (clipboardStore.isReady()) {
      clipboardStore.cleanup(savedConfig.clipboard?.retentionDays ?? 30);
    }
    // 搜索浮窗下次呼出会重新读取；如果它当前仍在显示，也立即刷新结果。
    if (win && !win.isDestroyed()) {
      win.webContents.send("weborg:config", savedConfig, lastQuery);
    }
    return { ok: true, config: savedConfig };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
});

ipcMain.handle("weborg:search-clipboard", (event, query) => {
  return clipboardStore.search(query || "", 12);
});

ipcMain.handle("weborg:copy-clipboard", (event, id) => {
  try {
    const record = clipboardStore.get(id);
    if (!record) return { ok: false, reason: "剪切板记录不存在或已过期" };
    if (record.kind === "text") {
      clipboard.writeText(record.content);
    } else if (record.kind === "file") {
      const filePaths = clipboardStore.getFilePaths(id).filter((filePath) => fs.existsSync(filePath));
      if (!filePaths.length) return { ok: false, reason: "文件已不存在或无法访问" };
      const uriList = `${filePaths.map((filePath) => pathToFileURL(filePath).href).join("\r\n")}\r\n`;
      clipboard.clear();
      clipboard.writeBuffer("text/uri-list", Buffer.from(uriList, "utf8"));
      if (process.platform === "darwin") {
        const escapeXml = (value) => String(value).replace(/[<>&'\"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" }[char]));
        const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${filePaths.map((filePath) => `<string>${escapeXml(filePath)}</string>`).join("")}</array></plist>`;
        clipboard.writeBuffer("NSFilenamesPboardType", Buffer.from(plist, "utf8"));
      }
    } else {
      const imageBuffer = clipboardStore.getImageBuffer(id);
      if (!imageBuffer) return { ok: false, reason: "图片文件不存在或已损坏" };
      clipboard.writeImage(nativeImage.createFromBuffer(imageBuffer));
    }
    hideWindow();
    return { ok: true };
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
