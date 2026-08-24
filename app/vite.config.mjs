import { defineConfig } from "vite";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const uiDirectory = resolve(appDirectory, "ui");
const configPath = resolve(appDirectory, "..", "config.json");

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

export default defineConfig({
  root: uiDirectory,
  plugins: [localConfigApi()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
