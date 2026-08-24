import { defineConfig } from "vite";
import { execFile } from "node:child_process";
import { access, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const uiDirectory = resolve(appDirectory, "ui");
const defaultConfigPath = resolve(appDirectory, "..", "config.json");
const execFileAsync = promisify(execFile);
const applicationIconCache = new Map();
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
      const title = basename(applicationPath, ".app");
      applications.push({
        kind: "app",
        title,
        path: applicationPath,
        hay: `${title} ${entry.name} ${applicationPath}`.toLowerCase()
      });
    }
  }
  return applications.sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
}

function applications() {
  if (!applicationsPromise) applicationsPromise = scanApplications();
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

async function searchApplications(query = "", limit = 12) {
  const keyword = String(query || "").trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 12));
  const index = await applications();
  const matches = keyword ? index.filter((application) => application.hay.includes(keyword)) : index;
  const selected = matches.slice(0, safeLimit);
  await readNativeApplicationIcons(selected.map((application) => application.path));
  return selected.map((application) => ({ ...application, iconUrl: applicationIconCache.get(application.path) || "" }));
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("配置必须是 JSON 对象");
  if (!config.core || typeof config.core !== "object") throw new Error("配置缺少 core 对象");
  const configuredConfigPath = config.core.configPath;
  if (configuredConfigPath !== undefined && typeof configuredConfigPath !== "string") throw new Error("配置文件位置必须是字符串");
  if (String(configuredConfigPath || "").trim() && !isAbsolute(configuredConfigPath.trim())) throw new Error("配置文件位置必须是绝对路径");
  if (!config.plugins || typeof config.plugins !== "object") throw new Error("配置缺少 plugins 对象");
  const items = config.plugins.web?.settings?.items;
  if (!Array.isArray(items)) throw new Error("网页插件配置缺少 items 数组");
  const storagePath = config.plugins.clipboard?.settings?.storagePath;
  if (storagePath !== undefined && typeof storagePath !== "string") throw new Error("剪切板存放位置必须是字符串");
  if (String(storagePath || "").trim() && !isAbsolute(storagePath.trim())) throw new Error("剪切板存放位置必须是绝对路径");
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
            sendJson(response, 200, JSON.parse(await readFile(configPath, "utf8")));
            return;
          }
          if (request.method === "POST") {
            const config = validateConfig(JSON.parse(await requestBody(request)));
            const currentConfig = JSON.parse(await readFile(configPath, "utf8"));
            const currentConfigPath = String(currentConfig.core?.configPath || "").trim();
            const nextConfigPath = String(config.core?.configPath || "").trim();
            if (currentConfigPath !== nextConfigPath) throw new Error("请在 Electron App 中修改配置文件位置");
            const currentStoragePath = String(currentConfig.plugins?.clipboard?.settings?.storagePath || "").trim();
            const nextStoragePath = String(config.plugins?.clipboard?.settings?.storagePath || "").trim();
            if (currentStoragePath !== nextStoragePath) throw new Error("请在 Electron App 中修改剪切板存放位置");
            const temporaryPath = `${configPath}.vite-${process.pid}`;
            await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
            await rename(temporaryPath, configPath);
            sendJson(response, 200, { ok: true, config });
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
          const applications = await searchApplications(requestUrl.searchParams.get("q") || "", requestUrl.searchParams.get("limit") || 12);
          sendJson(response, 200, { ok: true, applications });
        } catch (error) {
          sendJson(response, 500, { ok: false, reason: error.message, applications: [] });
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

export default defineConfig({
  root: uiDirectory,
  plugins: [localConfigApi(), localApplicationApi(), localClipboardApi()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
