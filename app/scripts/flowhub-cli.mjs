#!/usr/bin/env node

const baseUrl = String(process.env.FLOWHUB_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
const args = process.argv.slice(2);

function usage() {
  console.log(`FlowHub CLI\n\n用法:\n  npm run cli -- config get\n  npm run cli -- config set <路径> <JSON值>\n  npm run cli -- config replace <JSON文件>\n  npm run cli -- web list\n  npm run cli -- memo list\n\n环境变量:\n  FLOWHUB_URL  服务地址，默认 http://127.0.0.1:4173\n\n路径使用点号分隔，例如 plugins.web.enabled；值必须是合法 JSON。`);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { accept: "application/json", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) throw new Error(body.reason || `请求失败：HTTP ${response.status}`);
  return body;
}

function setPath(object, path, value) {
  const parts = path.split(".").filter(Boolean);
  if (!parts.length) throw new Error("路径不能为空");
  let cursor = object;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

async function readConfig() { return request("/api/config"); }
async function writeConfig(config) {
  return request("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config) });
}

async function main() {
  const [resource, action, ...rest] = args;
  if (!resource || resource === "help" || resource === "--help" || resource === "-h") return usage();
  if (resource === "config") {
    if (action === "get") return console.log(JSON.stringify(await readConfig(), null, 2));
    if (action === "set") {
      if (!rest[0] || rest[1] === undefined) throw new Error("需要路径和值，例如 config set core.hotkey 'Alt+Space'");
      const config = await readConfig();
      setPath(config, rest[0], JSON.parse(rest[1]));
      await writeConfig(config);
      return console.log(JSON.stringify({ ok: true, path: rest[0], value: JSON.parse(rest[1]) }, null, 2));
    }
    if (action === "replace") {
      const fs = await import("node:fs/promises");
      const config = JSON.parse(await fs.readFile(rest[0], "utf8"));
      await writeConfig(config);
      return console.log(JSON.stringify({ ok: true }, null, 2));
    }
  }
  if ((resource === "web" || resource === "memo") && action === "list") {
    const config = await readConfig();
    const items = resource === "web" ? config.plugins?.web?.settings?.items : config.plugins?.memo?.settings?.items;
    return console.log(JSON.stringify(Array.isArray(items) ? items : [], null, 2));
  }
  throw new Error("未知命令；使用 flowhub help 查看帮助");
}

main().catch((error) => { console.error(`错误：${error.message}`); process.exitCode = 1; });
