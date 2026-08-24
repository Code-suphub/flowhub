// FlowHub 桌面启动器 - 主进程
// 类 uTools：Alt+空格 呼出全局搜索浮窗；搜索目录/网页/备注；回车用系统浏览器打开；
// 可配置"打开本地应用/命令"。不依赖浏览器扩展。
const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell, screen } = require("electron");
const { execFile, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { fileURLToPath, pathToFileURL } = require("url");
const clipboardStore = require("./clipboard-store");
const { PluginRegistry } = require("./plugins/registry");
const pluginRegistry = new PluginRegistry();

// 产品重命名后继续读取 Web Organization 的历史数据；新安装使用 FlowHub 默认目录。
const LEGACY_USER_DATA_PATH = path.join(app.getPath("appData"), "Web Organization");
if (fs.existsSync(LEGACY_USER_DATA_PATH)) app.setPath("userData", LEGACY_USER_DATA_PATH);

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

let win = null;
let settingsWin = null;
let lastQuery = "";
let clipboardTimer = null;
let clipboardPollInFlight = false;
let lastClipboardSignature = "";
let pendingSelfClipboardSignature = "";
let pendingSelfClipboardExpiresAt = 0;
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
let registeredHotkey = "";
const clipboardFileIconCache = new Map();
const applicationIconCache = new Map();
let applicationIndexPromise = null;
let blurHideTimer = null;
const CLIPBOARD_PERF_ENABLED = process.env.FLOWHUB_CLIPBOARD_PERF === "1" || process.env.WEBORG_CLIPBOARD_PERF === "1";

const MAC_NATIVE_PASTE_SCRIPT = [
  "ObjC.import('CoreGraphics');",
  "var source = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);",
  "var down = $.CGEventCreateKeyboardEvent(source, 9, true);",
  "var up = $.CGEventCreateKeyboardEvent(source, 9, false);",
  "if (!down || !up) throw new Error('无法创建粘贴键盘事件');",
  "$.CGEventSetFlags(down, $.kCGEventFlagMaskCommand);",
  "$.CGEventSetFlags(up, $.kCGEventFlagMaskCommand);",
  "$.CGEventPost($.kCGHIDEventTap, down);",
  "$.CGEventPost($.kCGHIDEventTap, up);"
].join(" ");
const MAC_NATIVE_PASTE_SOURCE = path.join(__dirname, "native", "macos-paste.swift");
let nativePasteHelperPromise = null;
let nativeIconReadQueue = Promise.resolve();

const MAC_NATIVE_ICON_SCRIPT = [
  "ObjC.import('AppKit');",
  "var args = $.NSProcessInfo.processInfo.arguments;",
  "var result = [];",
  "for (var i = 6; i < args.count; i++) {",
  "  var filePath = ObjC.unwrap(args.objectAtIndex(i));",
  "  var image = $.NSWorkspace.sharedWorkspace.iconForFile(filePath);",
  "  var bitmap = image ? $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation) : null;",
  "  var data = bitmap ? bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary) : null;",
  "  result.push(data ? ObjC.unwrap(data.base64EncodedStringWithOptions(0)) : '');",
  "}",
  "console.log(JSON.stringify(result));"
].join(" ");

function prepareNativePasteHelper() {
  if (process.platform !== "darwin") return Promise.resolve("");
  if (nativePasteHelperPromise) return nativePasteHelperPromise;
  nativePasteHelperPromise = new Promise((resolve) => {
    const helperDirectory = path.join(app.getPath("userData"), "native");
    const helperPath = path.join(helperDirectory, "macos-paste-v1");
    const sourcePath = path.join(helperDirectory, "macos-paste-v1.swift");
    const tempHelperPath = `${helperPath}.tmp-${process.pid}`;
    try {
      if (fs.existsSync(helperPath)) {
        resolve(helperPath);
        return;
      }
      fs.mkdirSync(helperDirectory, { recursive: true });
      fs.writeFileSync(sourcePath, fs.readFileSync(MAC_NATIVE_PASTE_SOURCE, "utf8"), "utf8");
    } catch (error) {
      console.warn("[flowhub] 无法准备原生粘贴助手:", error.message);
      resolve("");
      return;
    }
    execFile("swiftc", ["-O", sourcePath, "-o", tempHelperPath], { timeout: 15000 }, (error) => {
      if (error) {
        try { fs.unlinkSync(tempHelperPath); } catch {}
        console.warn("[flowhub] 编译原生粘贴助手失败，将使用系统兜底:", error.message);
        resolve("");
        return;
      }
      try {
        fs.renameSync(tempHelperPath, helperPath);
        resolve(helperPath);
      } catch (renameError) {
        console.warn("[flowhub] 保存原生粘贴助手失败:", renameError.message);
        resolve("");
      }
    });
  });
  return nativePasteHelperPromise;
}

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[flowhub] 读取配置失败:", e.message);
    return { core: { hotkey: "Alt+Space", launchAtLogin: false }, plugins: { web: { enabled: true, settings: { items: [] } }, clipboard: { enabled: true, settings: { retentionDays: 30, storagePath: "" } }, app: { enabled: true, settings: {} }, memo: { enabled: false, settings: {} } } };
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("配置必须是 JSON 对象");
  }
  if (!config.core || typeof config.core !== "object") throw new Error("配置缺少 core 对象");
  if (!config.plugins || typeof config.plugins !== "object") throw new Error("配置缺少 plugins 对象");
  const items = config.plugins.web?.settings?.items;
  if (!Array.isArray(items)) throw new Error("网页插件配置缺少 items 数组");
  const storagePath = config.plugins.clipboard?.settings?.storagePath;
  if (storagePath !== undefined && typeof storagePath !== "string") throw new Error("剪切板存放位置必须是字符串");
  if (String(storagePath || "").trim() && !path.isAbsolute(storagePath.trim())) throw new Error("剪切板存放位置必须是绝对路径");

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

  visit(items);
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

function defaultClipboardStoragePath() {
  return path.join(app.getPath("userData"), "clipboard");
}

function resolveClipboardStoragePath(config = readConfig()) {
  const configuredPath = String(config.plugins?.clipboard?.settings?.storagePath || "").trim();
  return configuredPath ? path.resolve(configuredPath) : defaultClipboardStoragePath();
}

function clipboardStorageInfo(config = readConfig()) {
  const configuredPath = String(config.plugins?.clipboard?.settings?.storagePath || "").trim();
  return {
    available: true,
    configuredPath,
    defaultPath: defaultClipboardStoragePath(),
    resolvedPath: resolveClipboardStoragePath(config),
    activePath: clipboardStore.storagePath() || ""
  };
}

async function switchClipboardStorage(config) {
  const targetPath = resolveClipboardStoragePath(config);
  const currentPath = clipboardStore.storagePath();
  if (!currentPath || path.resolve(currentPath) === targetPath) return { ...clipboardStorageInfo(config), migrated: false };
  const currentResolved = path.resolve(currentPath);
  if (targetPath.startsWith(`${currentResolved}${path.sep}`) || currentResolved.startsWith(`${targetPath}${path.sep}`)) {
    throw new Error("新的存放位置不能与当前数据目录互相嵌套");
  }

  const shouldRestartMonitor = Boolean(clipboardTimer);
  stopClipboardMonitor();
  clipboardStore.close();
  let migrated = false;
  try {
    fs.mkdirSync(targetPath, { recursive: true });
    const targetEntries = fs.readdirSync(targetPath);
    const targetDatabase = path.join(targetPath, "weborg.db");
    if (targetEntries.length && !fs.existsSync(targetDatabase)) {
      throw new Error("所选目录不是空目录，也不包含 FlowHub 数据库");
    }
    if (!targetEntries.length && fs.existsSync(currentResolved)) {
      for (const entry of fs.readdirSync(currentResolved)) {
        fs.cpSync(path.join(currentResolved, entry), path.join(targetPath, entry), { recursive: true, errorOnExist: true, force: false });
      }
      migrated = true;
    }
    await clipboardStore.open(targetPath);
    resetClipboardSnapshot();
  } catch (error) {
    try { await clipboardStore.open(currentResolved); } catch {}
    if (shouldRestartMonitor) startClipboardMonitor();
    throw error;
  }
  if (shouldRestartMonitor) startClipboardMonitor();
  return { ...clipboardStorageInfo(config), activePath: targetPath, migrated };
}

function clipboardSettings() {
  try {
    const mtime = fs.statSync(CONFIG_PATH).mtimeMs;
    if (clipboardSettingsCache && clipboardSettingsMtime === mtime) return clipboardSettingsCache;
    const config = readConfig();
    const clipboardPlugin = config.plugins?.clipboard;
    clipboardSettingsCache = {
      enabled: clipboardPlugin?.enabled !== false,
      retentionDays: Number(clipboardPlugin?.settings?.retentionDays ?? 30)
    };
    clipboardSettingsMtime = mtime;
    return clipboardSettingsCache;
  } catch {}
  const config = readConfig();
  const clipboardPlugin = config.plugins?.clipboard;
  return {
    enabled: clipboardPlugin?.enabled !== false,
    retentionDays: Number(clipboardPlugin?.settings?.retentionDays ?? 30)
  };
}

function hashBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clipboardPerfTimer(recordId) {
  if (!CLIPBOARD_PERF_ENABLED) return { mark() {}, finish() {} };
  const startedAt = process.hrtime.bigint();
  let previousAt = startedAt;
  const stages = {};
  return {
    mark(name) {
      const now = process.hrtime.bigint();
      stages[name] = Number(now - previousAt) / 1e6;
      previousAt = now;
    },
    finish(details = {}) {
      const total = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const roundedStages = Object.fromEntries(Object.entries(stages).map(([name, milliseconds]) => [name, Number(milliseconds.toFixed(1))]));
      console.log("[flowhub][clipboard-perf]", JSON.stringify({
        id: Number(recordId),
        ...details,
        stages: roundedStages,
        totalMs: Number(total.toFixed(1))
      }));
    }
  };
}

const FILE_CLIPBOARD_FORMATS = [
  "public.file-url",
  "NSFilenamesPboardType",
  "NSFilesPromisePboardType",
  "text/uri-list",
  "application/x-file-list",
  "com.apple.pasteboard.promised-file-url"
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

function clipboardImageFormatSignature(formats) {
  return [...new Set([
    ...formats.filter(isImageClipboardFormat),
    ...IMAGE_CLIPBOARD_FORMATS
  ])].filter((format) => hasClipboardFormat(format, formats)).sort().join("|");
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

function isPlaceholderFilePath(filePath) {
  return /(?:^|[\\/])\.file[\\/]id=/i.test(String(filePath || ""));
}

function resolveMacFileReference(filePath) {
  if (process.platform !== "darwin" || !isPlaceholderFilePath(filePath)) return "";
  try {
    // macOS 的文件引用 URL 不能由 Node 的 fileURLToPath 解析，
    // 交给 Foundation 的 NSURL.fileSystemRepresentation 才能还原实际路径。
    const script = [
      "ObjC.import('Foundation');",
      "var args = $.NSProcessInfo.processInfo.arguments;",
      "var url = $.NSURL.URLWithString(ObjC.unwrap(args.lastObject));",
      "if (url) { var path = ObjC.unwrap(url.path); if (path) console.log(path); }"
    ].join(" ");
    return execFileSync("osascript", ["-l", "JavaScript", "-e", script, "--", pathToFileURL(filePath).href], {
      encoding: "utf8",
      timeout: 1500,
      maxBuffer: 64 * 1024
    }).trim();
  } catch {
    return "";
  }
}

function parseFileClipboardData(buffer) {
  let raw = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");
  if (Buffer.isBuffer(buffer) && buffer.subarray(0, 8).toString("ascii") === "bplist00" && process.platform === "darwin") {
    try {
      raw = execFileSync("plutil", ["-convert", "xml1", "-o", "-", "--", "-"], {
        input: buffer,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024
      });
    } catch {}
  }
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
  // macOS 某些 Finder 文件类型不会出现在 availableFormats()/has()，但仍可通过原生 UTI 读取。
  const fileFormats = [...new Set([
    ...FILE_CLIPBOARD_FORMATS,
    ...formats.filter((format) => /uri-list|file-url|filenames|filename/i.test(String(format || "")))
  ])].filter((format) => process.platform === "darwin" || formats.includes(format) || hasClipboardFormat(format, formats));
  if (!fileFormats.length) {
    lastClipboardFileData = "";
    cachedClipboardFiles = null;
    return null;
  }

  const fileSources = [];
  const candidatePaths = [];
  for (const format of fileFormats) {
    const buffer = readClipboardFormat(format);
    const raw = buffer.toString("utf8");
    if (!raw) continue;
    const filePaths = parseFileClipboardData(buffer);
    if (!filePaths.length) continue;
    fileSources.push(`${format}\u0000${raw}`);
    candidatePaths.push(...filePaths);
  }

  const uniquePaths = [...new Set(candidatePaths)];
  const fileData = fileSources.join("\u0001");
  if (fileData === lastClipboardFileData && cachedClipboardFiles) return cachedClipboardFiles;

  const resolvedCandidates = uniquePaths.flatMap((filePath) => {
    if (!isPlaceholderFilePath(filePath)) return [filePath];
    const resolvedPath = resolveMacFileReference(filePath);
    return resolvedPath ? [resolvedPath] : [filePath];
  });
  // public.file-url 有时只返回 macOS 的文件引用占位符（/.file/id=...），
  // 而 NSFilenamesPboardType 同时包含真实路径；Foundation 还能解析文件引用 URL。
  // 必须遍历全部格式并解析后再选择，否则列表标题会变成“文件 · id=...”。
  const resolvedPaths = [...new Set(resolvedCandidates)];
  const filePaths = resolvedPaths.filter((filePath) => !isPlaceholderFilePath(filePath));
  if (resolvedPaths.length) {
    const selectedPaths = filePaths.length ? filePaths : resolvedPaths;
    lastClipboardFileData = fileData;
    cachedClipboardFiles = {
      kind: "file",
      value: selectedPaths,
      hash: hashBuffer(Buffer.from(selectedPaths.join("\u0000"), "utf8")),
      legacyPaths: filePaths.length ? uniquePaths.filter(isPlaceholderFilePath) : []
    };
    return cachedClipboardFiles;
  }
  try {
    const bookmark = clipboard.readBookmark();
    const bookmarkPath = filePathFromValue(bookmark?.url);
    if (bookmarkPath && !isPlaceholderFilePath(bookmarkPath)) {
      const filePaths = [bookmarkPath];
      const fileData = `bookmark\u0000${bookmark.url}`;
      if (fileData === lastClipboardFileData) return cachedClipboardFiles;
      lastClipboardFileData = fileData;
      cachedClipboardFiles = { kind: "file", value: filePaths, hash: hashBuffer(Buffer.from(filePaths.join("\u0000"), "utf8")) };
      return cachedClipboardFiles;
    }
  } catch {}
  lastClipboardFileData = "";
  cachedClipboardFiles = null;
  return null;
}

function readImageClipboardPayload(formats, now, filePayload) {
  const imageFormats = clipboardImageFormatSignature(formats);
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
          ? {
              kind: "image",
              value: buffer,
              hash: hashBuffer(buffer),
              sourceName: filePayload?.value?.length === 1 ? path.basename(filePayload.value[0]) : ""
            }
          : null;
      }
    } catch {
      cachedClipboardImage = null;
    }
    lastClipboardImageFormats = imageFormats;
    lastClipboardImageCheckAt = now;
  }
  if (cachedClipboardImage && !cachedClipboardImage.sourceName && filePayload?.value?.length === 1) {
    cachedClipboardImage = { ...cachedClipboardImage, sourceName: path.basename(filePayload.value[0]) };
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

function markOwnClipboardWrite(record, imageBuffer = null) {
  const signature = `${record.kind}:${record.hash}`;
  pendingSelfClipboardSignature = signature;
  pendingSelfClipboardExpiresAt = Date.now() + 2000;
  lastClipboardSignature = signature;
  if (record.kind === "text") {
    lastClipboardText = record.content;
    lastClipboardTextHash = record.hash;
    return;
  }
  if (record.kind === "image" && imageBuffer) {
    lastClipboardImageFormats = clipboardImageFormatSignature(clipboard.availableFormats());
    lastClipboardImageCheckAt = Date.now();
    cachedClipboardImage = {
      kind: "image",
      value: imageBuffer,
      hash: record.hash,
      sourceName: record.sourceName || ""
    };
    return;
  }
  if (record.kind === "file") {
    lastClipboardFileData = "";
    cachedClipboardFiles = null;
  }
}

function readClipboardPayloads(now = Date.now()) {
  const payloads = [];
  const formats = clipboard.availableFormats();
  const filePayload = readFileClipboardPayload(formats);
  const imagePayload = readImageClipboardPayload(formats, now, filePayload);

  const text = clipboard.readText();
  if (text !== lastClipboardText) {
    lastClipboardText = text;
    lastClipboardTextHash = text ? hashBuffer(Buffer.from(text, "utf8")) : "";
  }
  // Finder 复制文件时可能同时提供文件路径和预览图，必须优先保留文件路径，
  // 否则 PNG/TXT 等文件会被误记成图片；没有文件路径时才记录纯图片。
  if (filePayload) payloads.push(filePayload);
  else if (imagePayload) payloads.push(imagePayload);
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
    const now = Date.now();
    const isSelfWrite = signature
      && signature === pendingSelfClipboardSignature
      && now <= pendingSelfClipboardExpiresAt;
    if (isSelfWrite) {
      lastClipboardSignature = signature;
      pendingSelfClipboardSignature = "";
      pendingSelfClipboardExpiresAt = 0;
    } else if (signature && signature !== lastClipboardSignature) {
      clipboardStore.addBatch(payloads);
      lastClipboardSignature = signature;
      if (win && !win.isDestroyed()) win.webContents.send("weborg:clipboard-updated");
    } else if (!signature) {
      resetClipboardSnapshot();
    }

    if (pendingSelfClipboardExpiresAt && now > pendingSelfClipboardExpiresAt) {
      pendingSelfClipboardSignature = "";
      pendingSelfClipboardExpiresAt = 0;
    }
    if (now - lastClipboardCleanupAt > 60 * 1000) {
      clipboardStore.cleanup(settings.retentionDays);
      lastClipboardCleanupAt = now;
    }
  } catch (error) {
    console.error("[flowhub] 剪切板读取失败:", error.message);
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

function applicationDirectories() {
  const home = app.getPath("home");
  return [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    "/System/Library/CoreServices",
    path.join(home, "Applications")
  ];
}

function applicationDisplayName(applicationPath) {
  // 应用包名通常就是用户看到的名称；避免为每个 app 启动一次 plutil，
  // 让首次唤出和搜索保持轻量。原生图标仍由 app.getFileIcon 提供。
  return path.basename(applicationPath, ".app");
}

function scanApplications() {
  const applications = [];
  const seen = new Set();
  for (const directory of applicationDirectories()) {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith(".app")) continue;
      const applicationPath = path.join(directory, entry.name);
      if (seen.has(applicationPath)) continue;
      seen.add(applicationPath);
      const title = applicationDisplayName(applicationPath);
      applications.push({
        kind: "app",
        title,
        path: applicationPath,
        hay: `${title} ${entry.name} ${applicationPath}`.toLowerCase()
      });
    }
  }
  return applications.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
}

function applicationIndex() {
  if (!applicationIndexPromise) applicationIndexPromise = Promise.resolve().then(scanApplications);
  return applicationIndexPromise;
}

function readMacNativeIconsNow(filePaths, cache) {
  // 空字符串代表上一次读取失败；允许后续重试，避免应用启动时机不对导致永久显示 fallback 图标。
  const missingPaths = [...new Set(filePaths.filter((filePath) => filePath && !cache.get(filePath)))];
  if (process.platform !== "darwin" || !missingPaths.length) return Promise.resolve();
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", MAC_NATIVE_ICON_SCRIPT, "--", ...missingPaths], {
      timeout: 4000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8"
    }, (error, stdout, stderr) => {
      let icons = [];
      if (!error) {
        try {
          const parsed = JSON.parse(String(stdout || stderr).trim());
          if (Array.isArray(parsed)) icons = parsed;
        } catch {}
      }
      missingPaths.forEach((filePath, index) => {
        const base64 = String(icons[index] || "");
        cache.set(filePath, base64 ? `data:image/png;base64,${base64}` : "");
      });
      resolve();
    });
  });
}

function readMacNativeIcons(filePaths, cache) {
  // 应用搜索和常用入口会在启动时同时请求图标；串行化可以避免两次 osascript
  // 同时读取时，一条请求先拿到空结果并把 fallback 直接交给渲染层。
  const request = nativeIconReadQueue.then(
    () => readMacNativeIconsNow(filePaths, cache),
    () => readMacNativeIconsNow(filePaths, cache)
  );
  nativeIconReadQueue = request.catch(() => {});
  return request;
}

async function readMacNativeIconsWithRetry(filePaths, cache) {
  await readMacNativeIcons(filePaths, cache);
  const missingPaths = [...new Set(filePaths.filter((filePath) => filePath && !cache.get(filePath)))];
  if (missingPaths.length) await readMacNativeIcons(missingPaths, cache);
}

async function searchApplications(query = "", limit = 12) {
  const keyword = String(query || "").trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 12));
  const applications = await applicationIndex();
  const matches = keyword ? applications.filter((application) => application.hay.includes(keyword)) : applications;
  const selected = matches.slice(0, safeLimit);
  await readMacNativeIconsWithRetry(selected.map((application) => application.path), applicationIconCache);
  return selected.map((application) => ({ ...application, iconUrl: applicationIconCache.get(application.path) || "" }));
}

function flattenWebPages(nodes = [], parents = [], result = []) {
  for (const node of nodes) {
    const pathEntries = [...parents, { id: node.id, title: node.title, icon: node.icon }];
    if (node.url) {
      const page = { ...node, path: pathEntries, breadcrumb: pathEntries.map((entry) => entry.title).join(" / "), type: "page" };
      page.hay = `${page.title || ""} ${page.url || ""} ${page.breadcrumb} ${page.note || ""}`.toLowerCase();
      result.push(page);
    }
    flattenWebPages(node.children || [], pathEntries, result);
  }
  return result;
}

function searchWebPages(query = "", limit = 12) {
  const keyword = String(query || "").trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 12));
  const pages = flattenWebPages(readConfig().plugins?.web?.settings?.items || []);
  return (keyword ? pages.filter((page) => page.hay.includes(keyword)) : pages).slice(0, safeLimit);
}

async function searchUsage(scope = "all", limit = 6) {
  const sections = clipboardStore.usageSections(scope, limit);
  const allEntries = [...sections.frequent, ...sections.recent];
  const appEntries = allEntries.filter((entry) => entry.usageType === "app");
  await readMacNativeIconsWithRetry(appEntries.map((entry) => entry.path), applicationIconCache);
  const decorate = (entry) => entry.usageType === "app"
    ? { ...entry, type: "app", iconUrl: applicationIconCache.get(entry.path) || "" }
    : { ...entry, type: "page", id: entry.usageKey, icon: entry.icon || "", breadcrumb: entry.path };
  return {
    frequent: sections.frequent.map(decorate),
    recent: sections.recent.map(decorate)
  };
}

function isDev() {
  return process.argv.includes("--dev");
}

function loadRendererPage(browserWindow, pageName) {
  const rendererUrl = String(process.env.FLOWHUB_RENDERER_URL || process.env.WEBORG_RENDERER_URL || "").replace(/\/$/, "");
  if (isDev() && rendererUrl) {
    return browserWindow.loadURL(`${rendererUrl}/${pageName}`);
  }
  return browserWindow.loadFile(path.join(__dirname, "ui", pageName));
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

  loadRendererPage(win, "search.html");
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
    title: "FlowHub 配置管理",
    backgroundColor: "#101820",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  loadRendererPage(settingsWin, "settings.html");
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

function applyCoreConfig(config) {
  const hotkey = String(config.core?.hotkey || "Alt+Space").trim() || "Alt+Space";
  if (registeredHotkey && registeredHotkey !== hotkey) globalShortcut.unregister(registeredHotkey);
  let hotkeyRegistered = registeredHotkey === hotkey && globalShortcut.isRegistered(hotkey);
  if (!hotkeyRegistered) {
    try { hotkeyRegistered = globalShortcut.register(hotkey, () => toggleWindow()); } catch { hotkeyRegistered = false; }
  }
  registeredHotkey = hotkeyRegistered ? hotkey : "";
  if (app.isPackaged && typeof app.setLoginItemSettings === "function") {
    app.setLoginItemSettings({ openAtLogin: config.core?.launchAtLogin === true });
  }
  return { hotkey, hotkeyRegistered };
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    // 启动器不是普通 Dock 应用；使用 accessory 可避免唤出时切换到应用自己的 Space。
    app.setActivationPolicy("accessory");
  }

  const config = readConfig();
  try {
    // 使用记录和剪切板历史目前共用同一个 SQLite。数据库属于 App 核心数据服务，
    // 因此即使剪切板插件停用，常用入口与最近使用仍然可以正常工作。
    await clipboardStore.open(resolveClipboardStoragePath(config));
  } catch (error) {
    console.error("[flowhub] 共享数据存储初始化失败:", error.message);
  }
  const pluginFailures = await pluginRegistry.applyConfig(config, { app });
  pluginFailures.forEach((failure) => console.error(`[flowhub] 插件 ${failure.id} 初始化失败:`, failure.reason));
  createWindow();

  const coreState = applyCoreConfig(config);
  if (!coreState.hotkeyRegistered) {
    console.warn(`[flowhub] 无法注册 ${coreState.hotkey}（可能被系统/其它程序占用）。可在通用设置中修改。`);
  }

  // 冒烟测试：设置该环境变量时，启动后立即退出，便于 CI/无 GUI 环境验证主进程能跑通。
  if (process.env.FLOWHUB_SMOKE_TEST === "1" || process.env.WEBORG_SMOKE_TEST === "1") {
    console.log(`[flowhub] smoke test: 主进程已就绪，${coreState.hotkey} 全局快捷键注册:`, coreState.hotkeyRegistered);
    setTimeout(() => app.quit(), 500);
  }

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    pluginRegistry.stopAll();
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

ipcMain.handle("weborg:open-accessibility-settings", async () => {
  if (process.platform !== "darwin") return { ok: false, reason: "该快捷入口仅支持 macOS" };
  try {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
});

ipcMain.handle("weborg:get-clipboard-storage-info", () => clipboardStorageInfo());

ipcMain.handle("weborg:choose-clipboard-storage", async () => {
  const options = {
    title: "选择 FlowHub 数据存放目录",
    defaultPath: resolveClipboardStoragePath(),
    buttonLabel: "选择此目录",
    properties: ["openDirectory", "createDirectory"]
  };
  const owner = settingsWin && !settingsWin.isDestroyed() ? settingsWin : win && !win.isDestroyed() ? win : null;
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, path: path.resolve(result.filePaths[0]) };
});

ipcMain.handle("weborg:open-clipboard-storage", async () => {
  const storagePath = resolveClipboardStoragePath();
  try {
    fs.mkdirSync(storagePath, { recursive: true });
    const reason = await shell.openPath(storagePath);
    return reason ? { ok: false, reason } : { ok: true, path: storagePath };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
});

ipcMain.handle("weborg:save-config", async (event, config) => {
  try {
    validateConfig(config);
    const storageState = await switchClipboardStorage(config);
    writeConfig(config);
    const savedConfig = readConfig();
    const failures = await pluginRegistry.applyConfig(savedConfig, { app });
    const coreState = applyCoreConfig(savedConfig);
    // 搜索浮窗下次呼出会重新读取；如果它当前仍在显示，也立即刷新结果。
    if (win && !win.isDestroyed()) {
      win.webContents.send("weborg:config", savedConfig, lastQuery);
    }
    return { ok: true, config: savedConfig, pluginFailures: failures, coreState, storageState };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
});

ipcMain.handle("weborg:search-usage", (event, scope) => searchUsage(scope || "all", 6));

async function searchClipboardRecords({ query = "", kind = "all", limit = 30, offset = 0 } = {}) {
  const records = clipboardStore.search(query || "", limit || 30, kind || "all", offset || 0);
  const filePaths = records
    .filter((record) => record.kind === "file")
    .map((record) => record.filePaths?.find((candidate) => fs.existsSync(candidate)) || record.filePaths?.[0])
    .filter(Boolean);
  await readMacNativeIcons(filePaths, clipboardFileIconCache);
  return Promise.all(records.map(async (record) => {
    if (record.kind !== "file" || !record.filePaths?.length || typeof app.getFileIcon !== "function") return record;
    const filePath = record.filePaths.find((candidate) => fs.existsSync(candidate)) || record.filePaths[0];
    if (!filePath) return record;
    if (process.platform === "darwin") return { ...record, fileIconUrl: clipboardFileIconCache.get(filePath) || "" };
    if (clipboardFileIconCache.has(filePath)) {
      return { ...record, fileIconUrl: clipboardFileIconCache.get(filePath) };
    }
    try {
      const icon = await app.getFileIcon(filePath, { size: "small" });
      const fileIconUrl = icon.isEmpty() ? "" : icon.toDataURL();
      clipboardFileIconCache.set(filePath, fileIconUrl);
      return { ...record, fileIconUrl };
    } catch {
      clipboardFileIconCache.set(filePath, "");
      return record;
    }
  }));
}

async function copyClipboardRecord(id) {
  const perf = clipboardPerfTimer(id);
  let record = null;
  try {
    record = clipboardStore.get(id);
    perf.mark("lookup");
    if (!record) {
      perf.finish({ ok: false, reason: "not-found" });
      return { ok: false, reason: "剪切板记录不存在或已过期" };
    }
    let imageBuffer = null;
    if (record.kind === "text") {
      perf.mark("prepare");
      clipboard.writeText(record.content);
    } else if (record.kind === "file") {
      const filePaths = clipboardStore.getFilePaths(id).filter((filePath) => fs.existsSync(filePath));
      if (!filePaths.length) {
        perf.finish({ ok: false, kind: record.kind, reason: "missing-files" });
        return { ok: false, reason: "文件已不存在或无法访问" };
      }
      const uriList = `${filePaths.map((filePath) => pathToFileURL(filePath).href).join("\r\n")}\r\n`;
      const escapeXml = (value) => String(value).replace(/[<>&'\"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" }[char]));
      const plist = process.platform === "darwin"
        ? `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${filePaths.map((filePath) => `<string>${escapeXml(filePath)}</string>`).join("")}</array></plist>`
        : "";
      perf.mark("prepare");
      clipboard.clear();
      clipboard.writeBuffer("text/uri-list", Buffer.from(uriList, "utf8"));
      if (process.platform === "darwin") {
        clipboard.writeBuffer("NSFilenamesPboardType", Buffer.from(plist, "utf8"));
      }
    } else {
      imageBuffer = clipboardStore.getImageBuffer(id);
      if (!imageBuffer) {
        perf.finish({ ok: false, kind: record.kind, reason: "missing-image" });
        return { ok: false, reason: "图片文件不存在或已损坏" };
      }
      const image = nativeImage.createFromBuffer(imageBuffer);
      perf.mark("prepare");
      clipboard.writeImage(image);
    }
    perf.mark("clipboardWrite");
    markOwnClipboardWrite(record, imageBuffer);
    hideWindow();
    perf.mark("hide");
    const pasteResult = await pasteIntoPreviousApp();
    perf.mark("paste");
    perf.finish({
      ok: true,
      kind: record.kind,
      pasted: pasteResult.ok,
      transport: pasteResult.transport || "none",
      handoffMs: pasteResult.handoffMs,
      sendMs: pasteResult.sendMs
    });
    return { ok: true, pasted: pasteResult.ok, pasteReason: pasteResult.reason || "" };
  } catch (error) {
    perf.finish({ ok: false, kind: record?.kind || "unknown", reason: error.message });
    return { ok: false, reason: error.message };
  }
}

async function deleteClipboardRecord(recordId, ownerWindow = null) {
  const record = clipboardStore.get(recordId);
  if (!record) return { ok: false, reason: "剪切板记录不存在或已删除" };
  const label = record.kind === "file"
    ? (record.fileNames || []).join("、") || "文件"
    : record.kind === "image" ? (record.sourceName || "图片") : "文本记录";
  const options = {
    type: "warning",
    title: "删除剪切板记录",
    message: `确定删除“${label}”吗？`,
    detail: "只删除剪切板历史和应用保存的图片副本，不会删除原始文件。",
    buttons: ["删除", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  };
  const response = ownerWindow && !ownerWindow.isDestroyed()
    ? await dialog.showMessageBox(ownerWindow, options)
    : await dialog.showMessageBox(options);
  if (response.response !== 0) return { ok: false, cancelled: true };
  const removed = clipboardStore.remove(recordId);
  if (!removed) return { ok: false, reason: "剪切板记录不存在或已删除" };
  if (win && !win.isDestroyed()) win.webContents.send("weborg:clipboard-updated");
  return { ok: true };
}

function showClipboardRecordMenu(id, ownerWindow = null) {
  const recordId = Number(id);
  const record = clipboardStore.get(recordId);
  if (!record) return { ok: false, reason: "剪切板记录不存在或已删除" };
  const menu = Menu.buildFromTemplate([
    {
      label: "删除剪切板记录",
      click: () => { void deleteClipboardRecord(recordId, ownerWindow); }
    }
  ]);
  menu.popup({ window: ownerWindow || undefined });
  return { ok: true };
}

// 用系统浏览器/默认应用打开
async function openWebPage(url, usage = {}) {
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "非 http(s) 链接" };
  try {
    await shell.openExternal(url);
    if (usage?.type === "page") {
      clipboardStore.recordUsage({
        type: "page",
        key: usage.id || usage.url || url,
        title: usage.title || url,
        path: usage.breadcrumb || "",
        url,
        icon: usage.icon || ""
      });
      if (win && !win.isDestroyed()) win.webContents.send("weborg:usage-updated");
    }
    hideWindow();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// 启动本地命令（如打开本地工具）。允许白名单模式：仅接受明显可执行/本地路径。
async function openLocalApplication(action, usage = {}) {
  if (typeof action !== "string" || !action.trim()) return { ok: false };
  const cmd = action.trim();
  // 用系统默认方式处理本地路径（文件/文件夹/可执行）
  // 直接用 shell.openPath 打开路径；对命令型（如 cli）用 exec 需谨慎，这里仅处理路径。
  const result = await shell.openPath(cmd);
  if (result) return { ok: false, reason: result };
  if (usage?.type === "app") {
    clipboardStore.recordUsage({
      type: "app",
      key: usage.path || cmd,
      title: usage.title || path.basename(cmd, path.extname(cmd)),
      path: usage.path || cmd
    });
    if (win && !win.isDestroyed()) win.webContents.send("weborg:usage-updated");
  }
  hideWindow();
  return { ok: true };
}

pluginRegistry
  .register("web", {
    search: ({ query, limit }) => searchWebPages(query, limit),
    actions: { activate: ({ url, usage }) => openWebPage(url, usage) }
  })
  .register("app", {
    start: () => applicationIndex(),
    search: ({ query, limit }) => searchApplications(query, limit),
    actions: { activate: ({ path: applicationPath, usage }) => openLocalApplication(applicationPath, usage) }
  })
  .register("clipboard", {
    start: async () => {
      startClipboardMonitor();
      void prepareNativePasteHelper();
    },
    configure: (config) => {
      if (clipboardStore.isReady()) clipboardStore.cleanup(config.plugins?.clipboard?.settings?.retentionDays ?? 30);
    },
    stop: () => {
      stopClipboardMonitor();
    },
    search: searchClipboardRecords,
    actions: {
      activate: ({ id }) => copyClipboardRecord(id),
      menu: ({ id }, context) => showClipboardRecordMenu(id, context.ownerWindow),
      delete: ({ id }, context) => {
        const recordId = Number(id);
        if (!Number.isInteger(recordId) || recordId <= 0) return { ok: false, reason: "无效的剪切板记录" };
        return deleteClipboardRecord(recordId, context.ownerWindow);
      }
    }
  });

ipcMain.handle("weborg:list-plugins", () => pluginRegistry.list());
ipcMain.handle("weborg:plugin-search", (event, id, request) => pluginRegistry.search(id, request || {}));
ipcMain.handle("weborg:plugin-action", (event, id, action, payload) => pluginRegistry.action(id, action, payload || {}, {
  ownerWindow: BrowserWindow.fromWebContents(event.sender)
}));

function hideWindow() {
  if (win && !win.isDestroyed()) win.hide();
  if (process.platform === "darwin" && typeof app.hide === "function") app.hide();
}

function sendPasteWithAppleScript() {
  return new Promise((resolve) => {
    execFile("osascript", [
      "-e",
      'tell application "System Events" to keystroke "v" using command down'
    ], { timeout: 1500 }, (error) => {
      if (error) {
        console.warn("[flowhub] 自动粘贴失败，请在系统设置中允许 FlowHub 使用辅助功能:", error.message);
        resolve({ ok: false, reason: error.message, transport: "applescript" });
        return;
      }
      resolve({ ok: true, transport: "applescript" });
    });
  });
}

async function sendNativePaste() {
  // 首次启动可能仍在后台编译 Swift 助手；不要让第一次粘贴等待编译完成，先走轻量 JXA 兜底。
  const helperPath = nativePasteHelperPromise
    ? await Promise.race([
      nativePasteHelperPromise,
      new Promise((resolve) => setTimeout(() => resolve(""), 24))
    ])
    : await prepareNativePasteHelper();
  if (helperPath) {
    const nativeResult = await new Promise((resolve) => {
      execFile(helperPath, [], { timeout: 500 }, (error) => {
        resolve(error
          ? { ok: false, reason: error.message, transport: "swift" }
          : { ok: true, transport: "swift" });
      });
    });
    if (nativeResult.ok) return nativeResult;
  }

  // 原生助手不可用时使用 JXA；它仍比启动 System Events 更轻，且保留最终兜底能力。
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", MAC_NATIVE_PASTE_SCRIPT], { timeout: 800 }, async (error) => {
      if (!error) {
        resolve({ ok: true, transport: "jxa" });
        return;
      }
      resolve(await sendPasteWithAppleScript());
    });
  });
}

function pasteIntoPreviousApp() {
  if (process.platform !== "darwin") return Promise.resolve({ ok: false, reason: "当前平台暂不支持自动粘贴" });
  return new Promise((resolve) => {
    // 隐藏面板后给 macOS 一个最短的焦点交接时间；只有 Electron 仍保持焦点时才继续等待。
    const startedAt = Date.now();
    const minimumHandoffMs = 32;
    const maximumHandoffMs = 140;
    const waitForPreviousApp = () => {
      const elapsed = Date.now() - startedAt;
      const electronStillFocused = typeof app.isFocused === "function" && app.isFocused();
      if (elapsed < minimumHandoffMs || (electronStillFocused && elapsed < maximumHandoffMs)) {
        setTimeout(waitForPreviousApp, 8);
        return;
      }
      const handoffMs = Date.now() - startedAt;
      const sendStartedAt = Date.now();
      void sendNativePaste().then((result) => resolve({
        ...result,
        handoffMs,
        sendMs: Date.now() - sendStartedAt
      }));
    };
    waitForPreviousApp();
  });
}

app.on("window-all-closed", (e) => {
  // 保持后台，不退出
});

app.on("activate", () => {
  if (!win) createWindow();
});
