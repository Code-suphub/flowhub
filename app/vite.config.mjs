import { defineConfig } from "vite";
import { execFile } from "node:child_process";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const uiDirectory = resolve(appDirectory, "ui");
const configPath = resolve(appDirectory, "..", "config.json");
const execFileAsync = promisify(execFile);
const applicationIconCache = new Map();
let applicationsPromise;

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
  if (!Array.isArray(config.items)) throw new Error("配置缺少 items 数组");
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
  visit(config.items);
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
          if (request.method === "GET") {
            sendJson(response, 200, JSON.parse(await readFile(configPath, "utf8")));
            return;
          }
          if (request.method === "POST") {
            const config = validateConfig(JSON.parse(await requestBody(request)));
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

export default defineConfig({
  root: uiDirectory,
  plugins: [localConfigApi(), localApplicationApi()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
