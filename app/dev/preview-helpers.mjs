import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

// Dev-preview helpers for app/vite.config.mjs. This module lives in app/dev/, so
// appDirectory is one level up; appDirectory anchors ui/, node_modules/ and the
// repository-root config.json.
const devDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(devDirectory, "..");

const uiDirectory = resolve(appDirectory, "ui");
const defaultConfigPath = resolve(appDirectory, "..", "config.json");
const execFileAsync = promisify(execFile);
const applicationIconCache = new Map();
const applicationIndexPath = join(homedir(), "Library", "Application Support", "FlowHub", "application-index.json");
let applicationsPromise;
let sqlJsPromise;

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


export {
  appDirectory,
  uiDirectory,
  defaultConfigPath,
  execFileAsync,
  applicationIconCache,
  applicationIndexPath,
  applicationsPromise,
  sqlJsPromise,
  configLocatorCandidates,
  activeConfigPath,
  configFileInfo,
  MAC_NATIVE_ICON_SCRIPT,
  MAC_APPLICATION_METADATA_SCRIPT,
  applicationDirectories,
  scanApplications,
  applicationFingerprint,
  loadApplicationIndex,
  applications,
  clipboardDatabaseCandidates,
  clipboardStorageInfo,
  clipboardDatabasePath,
  sqlJs,
  databaseRows,
  parseJsonArray,
  browserClipboardRecord,
  withClipboardDatabase,
  canonicalJson,
  webCatalogSignature,
  webCatalogNodeCount,
  readWebCatalog,
  hydrateWebCatalog,
  searchClipboardRecords,
  clipboardImage,
  readNativeApplicationIconBatch,
  readNativeApplicationIcons,
  searchApplications,
  loadApplicationIcons,
  sendJson,
  normalizeIpLocation,
  lookupIpLocation,
  cloudflareResponseDetails
};
