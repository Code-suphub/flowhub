import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const serverOrigin = process.env.APP_ORIGIN || `http://localhost:${port}`;
const configPath = join(rootDir, "config.json");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("配置必须是 JSON 对象");
  }
  if (!Array.isArray(config.items)) {
    throw new Error("配置缺少 items 数组");
  }
  return config;
}

function normalizeExternalUrl(value) {
  const url = String(value || "").trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(url)) return `https://${url}`;
  return "";
}

function frameAncestorsAllows(value, pageUrl) {
  const directives = value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const directive = directives.find((part) => part.toLowerCase().startsWith("frame-ancestors"));
  if (!directive) return { allowed: true };

  const sources = directive.split(/\s+/).slice(1);
  if (sources.includes("'none'")) return { allowed: false, reason: "CSP frame-ancestors 设置为 'none'" };
  if (sources.includes("*")) return { allowed: true };

  const embedder = new URL(serverOrigin);
  const target = new URL(pageUrl);
  for (const source of sources) {
    if (source === "'self'") {
      if (embedder.origin === target.origin) return { allowed: true };
      continue;
    }
    if (source === embedder.origin) return { allowed: true };
    if (source.endsWith(":") && `${embedder.protocol}` === source) return { allowed: true };
    if (source.startsWith("https://*.") || source.startsWith("http://*.")) {
      const sourceUrl = new URL(source.replace("*.", ""));
      if (embedder.protocol === sourceUrl.protocol && embedder.hostname.endsWith(`.${sourceUrl.hostname}`)) {
        return { allowed: true };
      }
    }
  }

  return { allowed: false, reason: "CSP frame-ancestors 未允许当前工作台嵌入" };
}

function inspectFramePolicy(headers, pageUrl) {
  const xFrameOptions = headers.get("x-frame-options");
  if (xFrameOptions) {
    const normalized = xFrameOptions.toLowerCase();
    if (normalized.includes("deny")) {
      return { embeddable: false, reason: "响应头 X-Frame-Options 为 DENY" };
    }
    if (normalized.includes("sameorigin") && new URL(pageUrl).origin !== serverOrigin) {
      return { embeddable: false, reason: "响应头 X-Frame-Options 为 SAMEORIGIN" };
    }
  }

  const csp = headers.get("content-security-policy");
  if (csp) {
    const result = frameAncestorsAllows(csp, pageUrl);
    if (!result.allowed) return { embeddable: false, reason: result.reason };
  }

  return { embeddable: true, reason: "未发现阻止 iframe 嵌入的响应头" };
}

async function probeUrl(url) {
  const normalizedUrl = normalizeExternalUrl(url);
  if (!normalizedUrl) {
    return { url, embeddable: true, status: "mock", reason: "非 HTTP 链接按内部模拟页面处理" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    let response = await fetch(normalizedUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "iframe-workspace-probe/1.0"
      }
    });

    if (response.status === 405 || response.status === 403) {
      response = await fetch(normalizedUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "range": "bytes=0-0",
          "user-agent": "iframe-workspace-probe/1.0"
        }
      });
    }

    const policy = inspectFramePolicy(response.headers, response.url || normalizedUrl);
    return {
      url,
      finalUrl: response.url || normalizedUrl,
      statusCode: response.status,
      status: policy.embeddable ? "embeddable" : "blocked",
      ...policy
    };
  } catch (error) {
    return {
      url,
      embeddable: false,
      status: "probe-error",
      reason: error.name === "AbortError" ? "链接探测超时" : `链接探测失败：${error.message}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function serveStatic(req, res, pathname) {
  const safePath = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(rootDir, safePath);
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "no-cache"
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", serverOrigin);
  if (requestUrl.pathname === "/api/config") {
    if (req.method === "GET") {
      try {
        sendJson(res, 200, JSON.parse(await readFile(configPath, "utf8")));
      } catch (error) {
        sendJson(res, 500, { ok: false, reason: `读取配置失败：${error.message}` });
      }
      return;
    }

    if (req.method === "POST") {
      try {
        const body = await readRequestBody(req);
        const config = validateConfig(JSON.parse(body));
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { ok: false, reason: error.message });
      }
      return;
    }

    res.writeHead(405, { allow: "GET, POST" });
    res.end("Method not allowed");
    return;
  }

  if (requestUrl.pathname === "/api/probe") {
    const url = requestUrl.searchParams.get("url");
    if (!url) {
      sendJson(res, 400, { embeddable: false, status: "bad-request", reason: "缺少 url 参数" });
      return;
    }
    sendJson(res, 200, await probeUrl(url));
    return;
  }

  await serveStatic(req, res, decodeURIComponent(requestUrl.pathname));
});

server.listen(port, () => {
  console.log(`FlowHub web workspace running at ${serverOrigin}`);
});
