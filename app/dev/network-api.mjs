import { readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  execFileAsync,
  sendJson,
  lookupIpLocation,
  cloudflareResponseDetails
} from "./preview-helpers.mjs";

export function localNetworkApi() {
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

