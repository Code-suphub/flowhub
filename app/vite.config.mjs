import { defineConfig } from "vite";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import configPersistence from "./config-persistence.js";

const { stripWebCatalogMirror } = configPersistence;

const appDirectory = dirname(fileURLToPath(import.meta.url));
const uiDirectory = resolve(appDirectory, "ui");
const defaultConfigPath = resolve(appDirectory, "..", "config.json");
const execFileAsync = promisify(execFile);
const applicationIconCache = new Map();
const applicationIndexPath = join(homedir(), "Library", "Application Support", "FlowHub", "application-index.json");
let applicationsPromise;
let sqlJsPromise;
const DEFAULT_SCOPE_SHORTCUTS = { all: "Shift+1", clipboard: "Shift+2", app: "Shift+3", web: "Shift+4", memo: "Shift+5" };

function configLocatorCandidates() {
  const applicationSupport = join(homedir(), "Library", "Application Support");
  return ["Web Organization", "FlowHub", "Electron"].map((name) => join(applicationSupport, name, "config-location.json"));
}

async function activeConfigPath() {
  for (const locatorPath of configLocatorCandidates()) {
    try { await access(locatorPath); } catch { continue; }
    try {
      const configuredPath = String(JSON.parse(await readFile(locatorPath, "utf8")).configPath || "").trim();
      if (!configuredPath) return defaultConfigPath;
      if (configuredPath && isAbsolute(configuredPath)) {
        try { await access(configuredPath); } catch { return defaultConfigPath; }
        return resolve(configuredPath);
      }
      return defaultConfigPath;
    } catch { return defaultConfigPath; }
  }
  return defaultConfigPath;
}

async function configFileInfo() {
  const activePath = await activeConfigPath();
  let configuredPath = "";
  try {
    const config = JSON.parse(await readFile(activePath, "utf8"));
    configuredPath = String(config.core?.configPath || "").trim();
  } catch {}
  return { available: false, configuredPath, defaultPath: defaultConfigPath, resolvedPath: configuredPath || defaultConfigPath, activePath };
}

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

const MAC_APPLICATION_METADATA_SCRIPT = [
  "ObjC.import('Foundation');",
  "var args = $.NSProcessInfo.processInfo.arguments;",
  "var result = [];",
  "for (var i = 6; i < args.count; i++) {",
  "  try {",
  "    var filePath = ObjC.unwrap(args.objectAtIndex(i));",
  "    var bundle = $.NSBundle.bundleWithPath(filePath);",
  "    var info = bundle ? (bundle.localizedInfoDictionary || bundle.infoDictionary) : null;",
  "    var displayValue = info && typeof info.objectForKey === 'function' ? (info.objectForKey('CFBundleDisplayName') || info.objectForKey('CFBundleName')) : null;",
  "    var identifierValue = bundle ? bundle.bundleIdentifier : null;",
  "    result.push({ displayName: displayValue ? ObjC.unwrap(displayValue) : '', bundleId: identifierValue ? ObjC.unwrap(identifierValue) : '' });",
  "  } catch (error) { result.push({ displayName: '', bundleId: '' }); }",
  "}",
  "console.log(JSON.stringify(result));"
].join(" ");

function applicationDirectories() {
  return [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    "/System/Library/CoreServices",
    join(homedir(), "Applications")
  ];
}

async function scanApplications() {
  const applications = [];
  const seen = new Set();
  for (const directory of applicationDirectories()) {
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith(".app")) continue;
      const applicationPath = join(directory, entry.name);
      if (seen.has(applicationPath)) continue;
      seen.add(applicationPath);
      applications.push({
        kind: "app",
        title: basename(applicationPath, ".app"),
        fileName: entry.name,
        path: applicationPath,
        bundleId: ""
      });
    }
  }
  if (process.platform === "darwin" && applications.length) {
    try {
      const { stdout, stderr } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", MAC_APPLICATION_METADATA_SCRIPT, "--", ...applications.map((application) => application.path)], {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8"
      });
      const metadata = JSON.parse(String(stdout || stderr).trim());
      applications.forEach((application, index) => {
        const displayName = String(metadata[index]?.displayName || "").trim();
        const bundleId = String(metadata[index]?.bundleId || "").trim();
        const packageName = basename(application.path, ".app");
        application.title = displayName || packageName;
        application.bundleId = bundleId;
        application.hay = `${displayName} ${packageName} ${application.fileName} ${bundleId} ${application.path}`.toLowerCase();
      });
    } catch {}
  }
  applications.forEach((application) => {
    if (application.hay) return;
    const packageName = basename(application.path, ".app");
    application.hay = `${packageName} ${application.fileName} ${application.path}`.toLowerCase();
  });
  return applications.sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
}

async function applicationFingerprint() {
  const entries = [];
  for (const directory of applicationDirectories()) {
    let children = [];
    try { children = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of children) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith(".app")) continue;
      const path = join(directory, entry.name);
      let modified = "";
      try { modified = String(Math.floor((await stat(path)).mtimeMs / 1000)); } catch {}
      entries.push(`${path}:${modified}`);
    }
  }
  return entries.sort().join("\n");
}

async function loadApplicationIndex() {
  const fingerprint = await applicationFingerprint();
  try {
    const cached = JSON.parse(await readFile(applicationIndexPath, "utf8"));
    if (cached?.fingerprint === fingerprint && Array.isArray(cached.applications) && cached.applications.length) {
      return cached.applications;
    }
  } catch {}
  const scanned = await scanApplications();
  try {
    await writeFile(applicationIndexPath, `${JSON.stringify({ version: 1, fingerprint, applications: scanned }, null, 2)}\n`, "utf8");
  } catch {}
  return scanned;
}

function applications() {
  if (!applicationsPromise) applicationsPromise = loadApplicationIndex();
  return applicationsPromise;
}

async function clipboardDatabaseCandidates() {
  const applicationSupport = join(homedir(), "Library", "Application Support");
  let configuredPath = "";
  try {
    const config = JSON.parse(await readFile(await activeConfigPath(), "utf8"));
    configuredPath = String(config.plugins?.clipboard?.settings?.storagePath || "").trim();
  } catch {}
  return [
    configuredPath && join(configuredPath, "weborg.db"),
    join(applicationSupport, "Web Organization", "clipboard", "weborg.db"),
    join(applicationSupport, "FlowHub", "clipboard", "weborg.db"),
    join(applicationSupport, "Electron", "clipboard", "weborg.db")
  ].filter(Boolean);
}

async function clipboardStorageInfo() {
  const applicationSupport = join(homedir(), "Library", "Application Support");
  const legacyPath = join(applicationSupport, "Web Organization", "clipboard");
  const defaultPath = await access(legacyPath).then(() => legacyPath).catch(() => join(applicationSupport, "FlowHub", "clipboard"));
  let configuredPath = "";
  try {
    const config = JSON.parse(await readFile(await activeConfigPath(), "utf8"));
    configuredPath = String(config.plugins?.clipboard?.settings?.storagePath || "").trim();
  } catch {}
  return {
    available: false,
    configuredPath,
    defaultPath,
    resolvedPath: configuredPath || defaultPath,
    activePath: ""
  };
}

async function clipboardDatabasePath() {
  for (const candidate of await clipboardDatabaseCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return "";
}

function sqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({ locateFile: (file) => resolve(appDirectory, "node_modules", "sql.js", "dist", file) });
  }
  return sqlJsPromise;
}

function databaseRows(database, sql, parameters = []) {
  const statement = database.prepare(sql);
  statement.bind(parameters);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function browserClipboardRecord(row) {
  const filePaths = row.kind === "file" ? parseJsonArray(row.file_paths) : [];
  const fileTypes = row.kind === "file" ? parseJsonArray(row.file_types) : [];
  const normalizedTypes = filePaths.map((filePath, index) => fileTypes[index] || (/\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg|ico)$/i.test(filePath) ? "image" : "file"));
  const distinctTypes = [...new Set(normalizedTypes)];
  return {
    id: Number(row.id),
    kind: row.kind,
    hash: row.hash,
    content: row.content || "",
    sourceName: row.source_name || "",
    filePaths,
    fileNames: filePaths.map((filePath) => basename(filePath)),
    fileCount: filePaths.length,
    fileTypes: normalizedTypes,
    fileType: distinctTypes.length === 1 ? distinctTypes[0] : "file",
    imageUrl: row.file_name ? `/__weborg/clipboard/image?id=${Number(row.id)}` : "",
    size: Number(row.size || 0),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    copyCount: Number(row.copy_count || 1)
  };
}

async function withClipboardDatabase(callback) {
  const databasePath = await clipboardDatabasePath();
  if (!databasePath) throw new Error("未找到 FlowHub 剪切板数据库");
  const [SQL, file] = await Promise.all([sqlJs(), readFile(databasePath)]);
  const database = new SQL.Database(file);
  try {
    return await callback(database, databasePath);
  } finally {
    database.close();
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function webCatalogSignature(items) {
  return createHash("sha256").update(JSON.stringify(canonicalJson(items || []))).digest("hex");
}

function webCatalogNodeCount(items) {
  return (items || []).reduce((count, node) => count + 1 + webCatalogNodeCount(node.children || []), 0);
}

async function readWebCatalog() {
  return withClipboardDatabase((database) => {
    const table = databaseRows(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_catalog_nodes'")[0];
    if (!table) return [];
    const stored = databaseRows(database, `
      SELECT id, parent_id, sort_order, data_json
      FROM web_catalog_nodes
      ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, parent_id, sort_order
    `);
    const nodes = new Map(stored.map((row) => {
      let node = {};
      try { node = JSON.parse(row.data_json || "{}"); } catch {}
      node.id = row.id;
      delete node.children;
      return [row.id, node];
    }));
    const roots = [];
    for (const row of stored) {
      const node = nodes.get(row.id);
      const parent = row.parent_id ? nodes.get(row.parent_id) : null;
      if (parent) {
        parent.children ||= [];
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  });
}

async function hydrateWebCatalog(config) {
  const items = await readWebCatalog().catch(() => []);
  config.plugins ||= {};
  config.plugins.web ||= { enabled: true, settings: {} };
  config.plugins.web.settings ||= {};
  config.plugins.web.settings.items = items;
  config.plugins.web.settings.catalogStorage = "sqlite";
  config.plugins.web.settings.catalogCount = webCatalogNodeCount(items);
  config.plugins.web.settings.catalogSignature = webCatalogSignature(items);
  return config;
}

async function searchClipboardRecords(query = "", limit = 30, kind = "all", offset = 0) {
  const keyword = String(query || "").trim();
  const normalizedKeyword = keyword.toLowerCase();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeKind = ["text", "image", "file"].includes(kind) ? kind : "all";
  return withClipboardDatabase((database) => {
    const total = Number(databaseRows(database, "SELECT COUNT(*) AS total FROM clipboard_records")[0]?.total || 0);
    const conditions = [];
    const parameters = [];
    if (keyword) {
      const like = `%${keyword}%`;
      const imageKeyword = ["图片", "图像", "image"].includes(normalizedKeyword) ? keyword : "";
      conditions.push("(content LIKE ? OR source_name LIKE ? OR hash LIKE ? OR (kind = 'image' AND ? <> ''))");
      parameters.push(like, like, like, imageKeyword);
    }
    if (safeKind === "text") conditions.push("kind = 'text'");
    if (safeKind === "image") conditions.push("kind IN ('image', 'file')");
    if (safeKind === "file") conditions.push("kind = 'file'");
    const requiresFileClassification = safeKind === "image" || safeKind === "file";
    if (!requiresFileClassification) parameters.push(safeLimit, safeOffset);
    const records = databaseRows(
      database,
      `SELECT * FROM clipboard_records
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY last_seen_at DESC
       ${requiresFileClassification ? "" : "LIMIT ? OFFSET ?"}`,
      parameters
    );
    const publicRecords = records.map(browserClipboardRecord).filter((record) => {
      if (safeKind === "text") return record.kind === "text";
      if (safeKind === "image") return record.kind === "image" || (record.kind === "file" && record.fileType === "image");
      if (safeKind === "file") return record.kind === "file" && record.fileType !== "image";
      return true;
    }).slice(requiresFileClassification ? safeOffset : 0, requiresFileClassification ? safeOffset + safeLimit : safeLimit);
    return { total, records: publicRecords };
  });
}

async function clipboardImage(recordId) {
  return withClipboardDatabase(async (database, databasePath) => {
    const row = databaseRows(database, "SELECT file_name FROM clipboard_records WHERE id = ? AND kind = 'image'", [recordId])[0];
    const fileName = String(row?.file_name || "");
    if (!fileName || basename(fileName) !== fileName) throw new Error("图片记录不存在");
    return readFile(join(dirname(databasePath), "images", fileName));
  });
}

async function readNativeApplicationIconBatch(filePaths) {
  try {
    const { stdout, stderr } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", MAC_NATIVE_ICON_SCRIPT, "--", ...filePaths], {
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8"
    });
    const icons = JSON.parse(String(stdout || stderr).trim());
    filePaths.forEach((filePath, index) => {
      const base64 = String(icons[index] || "");
      if (base64) applicationIconCache.set(filePath, `data:image/png;base64,${base64}`);
    });
  } catch {}
}

async function readNativeApplicationIcons(filePaths) {
  const missing = [...new Set(filePaths.filter((filePath) => filePath && !applicationIconCache.get(filePath)))];
  if (process.platform !== "darwin" || !missing.length) return;
  // NSWorkspace 批量读取过多图标时容易超过脚本超时；小批次串行执行更稳定，
  // 且失败结果不写入缓存，后续搜索仍可重试。
  for (let index = 0; index < missing.length; index += 10) {
    await readNativeApplicationIconBatch(missing.slice(index, index + 10));
  }
}

async function searchApplications(query = "", limit = 12, offset = 0, includeIcons = true) {
  const keyword = String(query || "").trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 12));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const index = await applications();
  const matches = keyword ? index.filter((application) => application.hay.includes(keyword)) : index;
  const selected = matches.slice(safeOffset, safeOffset + safeLimit);
  if (includeIcons) await readNativeApplicationIcons(selected.map((application) => application.path));
  return selected.map((application) => ({
    ...application,
    iconUrl: includeIcons ? (applicationIconCache.get(application.path) || "") : ""
  }));
}

async function loadApplicationIcons(paths = []) {
  const index = await applications();
  const allowed = new Set(index.map((application) => application.path));
  const selected = [...new Set(paths)].filter((path) => allowed.has(path));
  await readNativeApplicationIcons(selected);
  return Object.fromEntries(selected.map((path) => [path, applicationIconCache.get(path) || ""]));
}

function validateScopeShortcuts(scopeShortcuts) {
  if (scopeShortcuts === undefined) return;
  if (!scopeShortcuts || typeof scopeShortcuts !== "object" || Array.isArray(scopeShortcuts)) throw new Error("范围快捷键必须是对象");
  const modifierAliases = { option: "alt", control: "ctrl", cmd: "meta", command: "meta", cmdorctrl: "commandorcontrol" };
  const modifiers = new Set(["shift", "alt", "ctrl", "meta", "commandorcontrol"]);
  const used = new Set();
  for (const scope of Object.keys(DEFAULT_SCOPE_SHORTCUTS)) {
    const shortcut = scopeShortcuts[scope];
    if (shortcut === undefined) continue;
    if (typeof shortcut !== "string") throw new Error(`${scope} 的范围快捷键必须是字符串`);
    const parts = shortcut.replace(/\s+/g, "").toLowerCase().split("+").filter(Boolean).map((part) => modifierAliases[part] || part);
    if (!parts.length) continue;
    const keys = parts.filter((part) => !modifiers.has(part));
    if (keys.length !== 1 || (!parts.some((part) => modifiers.has(part)) && !/^f(?:[1-9]|1\d|2[0-4])$/.test(keys[0]))) throw new Error(`${scope} 的范围快捷键格式无效：${shortcut}`);
    const canonical = [...new Set(parts.filter((part) => modifiers.has(part)))].sort().join("+") + `+${keys[0]}`;
    if (used.has(canonical)) throw new Error(`范围快捷键重复：${shortcut}`);
    used.add(canonical);
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("配置必须是 JSON 对象");
  if (!config.core || typeof config.core !== "object") throw new Error("配置缺少 core 对象");
  const configuredConfigPath = config.core.configPath;
  if (configuredConfigPath !== undefined && typeof configuredConfigPath !== "string") throw new Error("配置文件位置必须是字符串");
  if (String(configuredConfigPath || "").trim() && !isAbsolute(configuredConfigPath.trim())) throw new Error("配置文件位置必须是绝对路径");
  validateScopeShortcuts(config.core.scopeShortcuts);
  if (!config.plugins || typeof config.plugins !== "object") throw new Error("配置缺少 plugins 对象");
  const items = config.plugins.web?.settings?.items;
  if (!Array.isArray(items)) throw new Error("网页插件配置缺少 items 数组");
  const storagePath = config.plugins.clipboard?.settings?.storagePath;
  if (storagePath !== undefined && typeof storagePath !== "string") throw new Error("剪切板存放位置必须是字符串");
  if (String(storagePath || "").trim() && !isAbsolute(storagePath.trim())) throw new Error("剪切板存放位置必须是绝对路径");
  const memoItems = config.plugins.memo?.settings?.items;
  if (memoItems !== undefined && !Array.isArray(memoItems)) throw new Error("备忘录插件配置的 items 必须是数组");
  if (Array.isArray(memoItems)) {
    const memoIds = new Set();
    for (const item of memoItems) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("备忘录条目必须是对象");
      const id = String(item.id || "").trim();
      if (!id) throw new Error("每条备忘录都需要 id");
      if (memoIds.has(id)) throw new Error(`备忘录 id 重复：${id}`);
      if (!String(item.title || "").trim()) throw new Error(`备忘录 ${id} 缺少标题`);
      if (!String(item.content || "").trim()) throw new Error(`备忘录 ${id} 缺少内容`);
      memoIds.add(id);
    }
  }
  const ids = new Set();
  const visit = (nodes) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("目录节点必须是对象");
      const id = String(node.id || "").trim();
      if (!id) throw new Error("每个目录节点都需要 id");
      if (ids.has(id)) throw new Error(`目录 id 重复：${id}`);
      ids.add(id);
      if (node.children !== undefined && !Array.isArray(node.children)) throw new Error(`节点 ${id} 的 children 必须是数组`);
      visit(node.children || []);
    }
  };
  visit(items);
  return config;
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

function normalizeIpLocation(body) {
  return {
    ip: body?.ip || "",
    version: body?.version || body?.type || "",
    city: body?.city || "",
    region: body?.region || "",
    country_name: body?.country_name || body?.country || "",
    org: body?.org || body?.connection?.org || body?.connection?.isp || "",
    asn: body?.asn || body?.connection?.asn || "",
    timezone: typeof body?.timezone === "string" ? body.timezone : body?.timezone?.id || ""
  };
}

async function lookupIpLocation(address) {
  const encoded = encodeURIComponent(address);
  const providers = [
    `https://ipwho.is/${encoded}`,
    `https://ipapi.co/${encoded}/json/`
  ];
  let lastError = "IP 查询失败";
  for (const endpoint of providers) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.error || body?.success === false) {
        lastError = body?.reason || body?.message || `IP 查询失败：${response.status}`;
        continue;
      }
      return normalizeIpLocation(body);
    } catch (error) {
      lastError = error?.message || lastError;
    }
  }
  throw new Error(lastError);
}

function cloudflareResponseDetails(response) {
  const headers = Object.fromEntries([...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  const evidence = [];
  if (headers.server?.toLowerCase().includes("cloudflare")) evidence.push("server: cloudflare");
  if (headers["cf-ray"]) evidence.push("cf-ray");
  if (headers["cf-cache-status"]) evidence.push("cf-cache-status");
  if (headers["cf-mitigated"]) evidence.push(`cf-mitigated: ${headers["cf-mitigated"]}`);
  const cloudflare = evidence.length > 0;
  const challenge = Boolean(headers["cf-mitigated"]) || (cloudflare && [403, 429].includes(response.status));
  response.body?.cancel?.();
  return { status: response.status, cloudflare, challenge, evidence };
}

function localConfigApi() {
  return {
    name: "weborg-local-config-api",
    configureServer(server) {
      server.middlewares.use("/__weborg/config", async (request, response) => {
        try {
          if ((request.url || "").startsWith("/location")) {
            if (request.method !== "GET") {
              response.statusCode = 405;
              response.setHeader("allow", "GET");
              response.end("Read only");
              return;
            }
            sendJson(response, 200, { ok: true, readonly: true, ...(await configFileInfo()) });
            return;
          }
          const configPath = await activeConfigPath();
          if (request.method === "GET") {
            const config = JSON.parse(await readFile(configPath, "utf8"));
            sendJson(response, 200, await hydrateWebCatalog(config));
            return;
          }
          if (request.method === "POST") {
            const config = validateConfig(JSON.parse(await requestBody(request)));
            const currentConfig = JSON.parse(await readFile(configPath, "utf8"));
            const currentConfigPath = String(currentConfig.core?.configPath || "").trim();
            const nextConfigPath = String(config.core?.configPath || "").trim();
            if (currentConfigPath !== nextConfigPath) throw new Error("请在 FlowHub App 中修改配置文件位置");
            const currentStoragePath = String(currentConfig.plugins?.clipboard?.settings?.storagePath || "").trim();
            const nextStoragePath = String(config.plugins?.clipboard?.settings?.storagePath || "").trim();
            if (currentStoragePath !== nextStoragePath) throw new Error("请在 FlowHub App 中修改剪切板存放位置");
            const storedItems = await readWebCatalog();
            if (webCatalogSignature(config.plugins.web.settings.items) !== webCatalogSignature(storedItems)) {
              throw new Error("浏览器预览不能修改 SQLite 网页目录，请在 FlowHub App 的设置中编辑");
            }
            const persistedConfig = stripWebCatalogMirror(config);
            const temporaryPath = `${configPath}.vite-${process.pid}`;
            await writeFile(temporaryPath, `${JSON.stringify(persistedConfig, null, 2)}\n`, "utf8");
            await rename(temporaryPath, configPath);
            sendJson(response, 200, { ok: true, config: await hydrateWebCatalog(persistedConfig) });
            return;
          }
          response.statusCode = 405;
          response.setHeader("allow", "GET, POST");
          response.end("Method not allowed");
        } catch (error) {
          sendJson(response, 400, { ok: false, reason: error.message });
        }
      });
    }
  };
}

function localApplicationApi() {
  return {
    name: "weborg-local-application-api",
    configureServer(server) {
      server.middlewares.use("/__weborg/apps", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Method not allowed");
          return;
        }
        try {
          const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
          const applications = await searchApplications(requestUrl.searchParams.get("q") || "", requestUrl.searchParams.get("limit") || 12, requestUrl.searchParams.get("offset") || 0, requestUrl.searchParams.get("icons") !== "0");
          sendJson(response, 200, { ok: true, applications });
        } catch (error) {
          sendJson(response, 500, { ok: false, reason: error.message, applications: [] });
        }
      });
      server.middlewares.use("/__weborg/app-icons", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Method not allowed");
          return;
        }
        try {
          const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
          const raw = requestUrl.searchParams.get("paths") || "[]";
          const paths = JSON.parse(raw);
          const icons = await loadApplicationIcons(Array.isArray(paths) ? paths : []);
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ ok: true, icons }));
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ ok: false, reason: error.message }));
        }
      });
    }
  };
}

function localClipboardApi() {
  return {
    name: "flowhub-local-readonly-clipboard-api",
    configureServer(server) {
      server.middlewares.use("/__weborg/clipboard/storage", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Read only");
          return;
        }
        sendJson(response, 200, { ok: true, readonly: true, ...(await clipboardStorageInfo()) });
      });

      server.middlewares.use("/__weborg/clipboard/records", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Read only");
          return;
        }
        try {
          const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
          const result = await searchClipboardRecords(
            requestUrl.searchParams.get("q") || "",
            requestUrl.searchParams.get("limit") || 30,
            requestUrl.searchParams.get("kind") || "all",
            requestUrl.searchParams.get("offset") || 0
          );
          sendJson(response, 200, { ok: true, readonly: true, ...result });
        } catch (error) {
          sendJson(response, 500, { ok: false, readonly: true, reason: error.message, total: 0, records: [] });
        }
      });

      server.middlewares.use("/__weborg/clipboard/image", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Read only");
          return;
        }
        try {
          const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
          const id = Number(requestUrl.searchParams.get("id"));
          if (!Number.isInteger(id) || id <= 0) throw new Error("图片记录 ID 无效");
          const image = await clipboardImage(id);
          response.statusCode = 200;
          response.setHeader("content-type", "image/png");
          response.setHeader("cache-control", "private, no-store");
          response.end(image);
        } catch (error) {
          sendJson(response, 404, { ok: false, readonly: true, reason: error.message });
        }
      });
    }
  };
}

function localNetworkApi() {
  async function mihomoApi(apiPath) {
    if (process.platform !== "darwin") return null;
    let entries = [];
    try { entries = await readdir("/tmp", { withFileTypes: true }); } catch { return null; }
    const sockets = entries
      .filter((entry) => entry.isSocket?.() && /^mihomo-party-.*\.sock$/.test(entry.name))
      .map((entry) => join("/tmp", entry.name));
    for (const socket of sockets) {
      try {
        const { stdout } = await execFileAsync("curl", ["--unix-socket", socket, "-sS", "--max-time", "2", `http://mihomo${apiPath}`], { timeout: 3000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
        return JSON.parse(String(stdout || ""));
      } catch {}
    }
    return null;
  }

  async function clashRestApi(apiPath) {
    if (process.platform !== "darwin") return null;
    for (const port of [9090, 9097, 7897]) {
      try {
        const { stdout } = await execFileAsync("curl", ["--noproxy", "*", "-sS", "--max-time", "1", `http://127.0.0.1:${port}${apiPath}`], { timeout: 1500, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
        return JSON.parse(String(stdout || ""));
      } catch {}
    }
    return null;
  }

  function nodeFromConnections(payload) {
    const connections = Array.isArray(payload?.connections) ? payload.connections : [];
    const latest = connections
      .filter((connection) => connection?.metadata?.remoteDestination)
      .sort((left, right) => String(right.start || "").localeCompare(String(left.start || "")))[0];
    if (!latest) return null;
    return {
      nodeName: Array.isArray(latest.chains) && latest.chains.length ? latest.chains[0] : "",
      remoteAddress: latest.metadata.remoteDestination,
      chains: Array.isArray(latest.chains) ? latest.chains : [],
      observedAt: latest.start || ""
    };
  }

  async function currentProxyNode(adapter = "auto") {
    if (adapter === "system") return null;
    if (adapter === "mihomo") return nodeFromConnections(await mihomoApi("/connections"));
    if (adapter === "clash-rest") return nodeFromConnections(await clashRestApi("/connections"));
    return nodeFromConnections(await mihomoApi("/connections")) || nodeFromConnections(await clashRestApi("/connections"));
  }

  return {
    name: "flowhub-local-network-api",
    configureServer(server) {
      server.middlewares.use("/__weborg/proxy", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Method not allowed");
          return;
        }
        try {
          const { stdout } = await execFileAsync("scutil", ["--proxy"], { timeout: 3000, encoding: "utf8" });
          const values = Object.fromEntries(String(stdout || "").split("\n").map((line) => line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.*)\s*$/)).filter(Boolean).map((match) => [match[1], match[2]]));
          const proxy = (name) => ({
            enabled: values[`${name}Enable`] === "1",
            host: values[`${name}Proxy`] || "",
            port: values[`${name}Port`] || ""
          });
          const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
          const adapter = requestUrl.searchParams.get("adapter") || "auto";
          sendJson(response, 200, { http: proxy("HTTP"), https: proxy("HTTPS"), socks: proxy("SOCKS"), node: await currentProxyNode(adapter) });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: error.message || "代理检测失败" });
        }
      });
      server.middlewares.use("/__weborg/local-ip", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Method not allowed");
          return;
        }
        let geo = {};
        try {
          const result = await fetch("https://ipapi.co/json/", { signal: AbortSignal.timeout(6000) });
          if (result.ok) geo = await result.json();
        } catch {}
        const fetchIp = async (endpoint) => {
          const result = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
          if (!result.ok) throw new Error("IP endpoint unavailable");
          const text = (await result.text()).trim();
          try { return JSON.parse(text).ip || ""; } catch { return text; }
        };
        const [ipv4, ipv6] = await Promise.allSettled([
          fetchIp("https://api4.ipify.org?format=json"),
          fetchIp("https://api6.ipify.org?format=json")
        ]);
        const body = {
          ...geo,
          ipv4: ipv4.status === "fulfilled" ? ipv4.value : "",
          ipv6: ipv6.status === "fulfilled" ? ipv6.value : ""
        };
        if (!body.ipv4) {
          for (const endpoint of ["https://ifconfig.me/ip", "https://icanhazip.com"]) {
            try {
              const result = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
              if (result.ok) {
                body.ipv4 = (await result.text()).trim();
                break;
              }
            } catch {}
          }
        }
        if (body.ipv4 || body.ipv6) {
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.end(JSON.stringify(body));
          return;
        }
        sendJson(response, 502, { ok: false, error: "本机 IP 查询失败" });
      });
      server.middlewares.use("/__weborg/ip", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Method not allowed");
          return;
        }
        try {
          const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
          const address = String(requestUrl.searchParams.get("ip") || "").trim();
          if (!isIP(address)) throw new Error("IP 地址格式无效");
          sendJson(response, 200, await lookupIpLocation(address));
        } catch (error) {
          sendJson(response, 400, { ok: false, error: true, reason: error.message || "IP 查询失败" });
        }
      });
      server.middlewares.use("/__weborg/cloudflare", async (request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("allow", "GET");
          response.end("Method not allowed");
          return;
        }
        try {
          const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
          const hostname = String(requestUrl.searchParams.get("hostname") || "").trim().toLowerCase();
          if (isIP(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(hostname)) {
            throw new Error("域名格式无效");
          }
          const result = await fetch(`https://${hostname}/`, {
            method: "GET",
            redirect: "manual",
            headers: { accept: "text/html,application/xhtml+xml" },
            signal: AbortSignal.timeout(6000)
          });
          sendJson(response, 200, cloudflareResponseDetails(result));
        } catch (error) {
          sendJson(response, 400, { ok: false, error: true, reason: error.message || "Cloudflare 检测失败" });
        }
      });
    }
  };
}

export default defineConfig({
  root: uiDirectory,
  plugins: [localConfigApi(), localApplicationApi(), localClipboardApi(), localNetworkApi()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
