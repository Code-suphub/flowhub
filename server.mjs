import { createServer } from "node:http";
import { open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./extension/src/config-contract.js";

function validateConfig(config) {
  try { return globalThis.FlowHubLegacyCatalog.validate(config); }
  catch (error) { throw fail(400, error.message); }
}

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
const token = randomBytes(32).toString("hex");
const BODY_LIMIT = 1024 * 1024;
const DEADLINE_MS = 5000;
const MAX_ACTIVE = 16;
let active = 0;
let writing = false;
let authorities;

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// Only fixed, top-level public files are readable. Never follow a config/index symlink.
async function readPublicFile(name) {
  const file = await open(join(rootDir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > BODY_LIMIT) throw fail(500, "文件不可用或过大");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function readBody(req) {
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
    throw fail(413, "配置不能超过 1 MiB");
  }
  const chunks = [];
  let size = 0;
  // Event listeners allow an early response without async-iterator destruction of the socket.
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAbort);
      req.off("error", onError);
    };
    const onError = () => { cleanup(); reject(fail(400, "请求中断")); };
    const onAbort = onError;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) { cleanup(); req.pause(); reject(fail(413, "配置不能超过 1 MiB")); }
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAbort);
    req.once("error", onError);
  });
}

async function saveConfig(config) {
  // Bound the serialized representation too, so every saved config can be read back.
  const content = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(content) > BODY_LIMIT) throw fail(413, "配置不能超过 1 MiB");
  validateConfig(config);
  const path = join(rootDir, `.config-${randomBytes(16).toString("hex")}.tmp`);
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    // rename replaces a symlink itself; it never writes through its target.
    await rename(path, join(rootDir, "config.json"));
  } finally {
    await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function checkBoundary(req, pathname) {
  if (!authorities.has(req.headers.host)) throw fail(403, "Host 不受信任");
  const origin = req.headers.origin;
  const sameOrigin = origin === `http://${req.headers.host}`;
  const extensionRead = pathname === "/api/config" && req.method === "GET"
    && /^chrome-extension:\/\/[a-p]{32}$/.test(origin || "");
  if (origin !== undefined && !sameOrigin && !extensionRead) throw fail(403, "Origin 不受信任");
  if (req.headers["sec-fetch-site"] === "cross-site" && !extensionRead) throw fail(403, "禁止跨站访问");
}

async function route(req, res) {
  if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) throw fail(400, "无效 URL");
  let pathname;
  try { pathname = decodeURIComponent(req.url.split("?")[0]); } catch { throw fail(400, "无效 URL 编码"); }
  checkBoundary(req, pathname);
  if (pathname === "/api/session" && req.method === "GET") {
    sendJson(res, 200, { token });
  } else if (pathname === "/api/config" && req.method === "GET") {
    let config;
    try { config = JSON.parse(await readPublicFile("config.json")); }
    catch (error) {
      if (error instanceof SyntaxError) throw fail(400, "无效 JSON 目录");
      throw error;
    }
    sendJson(res, 200, validateConfig(config));
  } else if (pathname === "/api/config" && req.method === "POST") {
    const supplied = Buffer.from(req.headers["x-flowhub-token"] || "");
    if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) throw fail(403, "缺少有效写入令牌");
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "")) throw fail(415, "需要 application/json");
    if (req.headers["content-encoding"]) throw fail(415, "不支持压缩请求体");
    if (writing) throw fail(429, "已有配置写入进行中，请稍后重试");
    writing = true;
    try {
      const body = await readBody(req);
      let config;
      try { config = JSON.parse(body); } catch { throw fail(400, "无效 JSON"); }
      if (req.aborted || res.destroyed) throw fail(400, "请求中断");
      await saveConfig(config);
      sendJson(res, 200, { ok: true });
    } finally { writing = false; }
  } else if (pathname === "/api/probe" && req.method === "GET") {
    sendJson(res, 200, { status: "disabled", embeddable: true, reason: "旧 Web 服务已停用网络探测；是否允许嵌入由浏览器判定" });
  } else if ((pathname === "/" || pathname === "/index.html") && ["GET", "HEAD"].includes(req.method)) {
    const content = await readPublicFile("index.html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : content);
  } else if (["/api/session", "/api/config", "/api/probe", "/", "/index.html"].includes(pathname)) {
    res.setHeader("allow", pathname === "/api/config" ? "GET, POST" : pathname.startsWith("/api/") ? "GET" : "GET, HEAD");
    throw fail(405, "不支持该请求方法");
  } else {
    throw fail(404, "Not found");
  }
}

const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000, connectionsCheckingInterval: 1000 }, (req, res) => {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  res.setHeader("referrer-policy", "no-referrer");
  // Close rejected/unfinished bodies too; no unbounded drain or pipelined work.
  res.setHeader("connection", "close");
  if (active >= MAX_ACTIVE) { sendJson(res, 503, { ok: false, reason: "服务繁忙" }); return; }
  active += 1;
  const deadline = setTimeout(() => {
    sendJson(res, 408, { ok: false, reason: "请求超时" });
    req.destroy();
  }, DEADLINE_MS);
  route(req, res).catch((error) => {
    sendJson(res, error.status || 500, { ok: false, reason: error.status ? error.message : "服务暂时不可用" });
  }).finally(() => { clearTimeout(deadline); active -= 1; });
});
server.maxConnections = 32;
server.setTimeout(DEADLINE_MS, (socket) => socket.destroy());
server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
});
server.listen(port, "127.0.0.1", () => {
  const actualPort = server.address().port;
  authorities = new Set([`localhost:${actualPort}`, `127.0.0.1:${actualPort}`]);
  console.log(`FlowHub web workspace running at http://127.0.0.1:${actualPort}`);
});
