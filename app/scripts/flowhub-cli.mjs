#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const baseUrl = String(process.env.FLOWHUB_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
const args = process.argv.slice(2);
const execFileAsync = promisify(execFile);
const diagnosticsDir = join(homedir(), "Library", "Application Support", "FlowHub");
const diagnosticsPath = join(diagnosticsDir, "diagnostics.jsonl");
const monitorConfigPath = join(diagnosticsDir, "monitoring.json");

function usage() {
  console.log(`FlowHub CLI\n\n用法:\n  npm run cli -- config get\n  npm run cli -- config set <路径> <JSON值>\n  npm run cli -- config replace <JSON文件>\n  npm run cli -- web list\n  npm run cli -- memo list\n  npm run cli -- diagnose\n  npm run cli -- monitor status|enable|disable|sample|clear|export <文件>\n\n环境变量:\n  FLOWHUB_URL  服务地址，默认 http://127.0.0.1:4173\n\n路径使用点号分隔，例如 plugins.web.enabled；值必须是合法 JSON。`);
}

async function ensureDiagnosticsDir() { await mkdir(diagnosticsDir, { recursive: true }); }
async function monitorStatus() {
  try { return JSON.parse(await readFile(monitorConfigPath, "utf8")); } catch { return { enabled: false, updatedAt: null }; }
}
async function setMonitor(enabled) {
  await ensureDiagnosticsDir();
  const status = { enabled, updatedAt: new Date().toISOString() };
  await writeFile(monitorConfigPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return status;
}
async function processSnapshot() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,%cpu=,%mem=,rss=,etime=,command="]);
  return stdout.split("\n").map((line) => line.trim()).filter((line) => /flowhub|webkit/i.test(line)).map((line) => {
    const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) return { command: line };
    const [, pid, ppid, cpu, mem, rssKb, elapsed, command] = match;
    return { pid: Number(pid), ppid: Number(ppid), cpuPercent: Number(cpu), memoryPercent: Number(mem), rssKb: Number(rssKb), elapsed, command };
  });
}
async function sampleDiagnostics() {
  const snapshot = { timestamp: new Date().toISOString(), processes: await processSnapshot() };
  await ensureDiagnosticsDir();
  await writeFile(diagnosticsPath, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", flag: "a" });
  return snapshot;
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
  const { token } = await request("/api/session");
  return request("/api/config", { method: "POST", headers: { "content-type": "application/json", "x-flowhub-token": token }, body: JSON.stringify(config) });
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
  if (resource === "diagnose") return console.log(JSON.stringify(await sampleDiagnostics(), null, 2));
  if (resource === "monitor") {
    if (action === "status") return console.log(JSON.stringify(await monitorStatus(), null, 2));
    if (action === "enable" || action === "disable") return console.log(JSON.stringify(await setMonitor(action === "enable"), null, 2));
    if (action === "sample") return console.log(JSON.stringify(await sampleDiagnostics(), null, 2));
    if (action === "clear") {
      await ensureDiagnosticsDir();
      await writeFile(diagnosticsPath, "", "utf8");
      return console.log(JSON.stringify({ ok: true, cleared: diagnosticsPath }, null, 2));
    }
    if (action === "export") {
      if (!rest[0]) throw new Error("需要导出目标文件路径");
      await access(diagnosticsPath);
      await mkdir(dirname(rest[0]), { recursive: true });
      await copyFile(diagnosticsPath, rest[0]);
      return console.log(JSON.stringify({ ok: true, path: rest[0] }, null, 2));
    }
  }
  throw new Error("未知命令；使用 flowhub help 查看帮助");
}

main().catch((error) => { console.error(`错误：${error.message}`); process.exitCode = 1; });
