import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitePath = resolve(appDirectory, "node_modules", ".bin", "vite");
const rendererUrl = process.env.FLOWHUB_RENDERER_URL || process.env.WEBORG_RENDERER_URL || "http://127.0.0.1:5173";
const children = new Set();
let stopping = false;

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: appDirectory, stdio: "inherit", ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

async function waitForRenderer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${rendererUrl}/search.html`, { cache: "no-store" });
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  }
  throw new Error(`Vite 启动超时：${rendererUrl}`);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const vite = run(vitePath, ["--config", "vite.config.mjs"]);
vite.once("exit", (code) => {
  if (!stopping) stop(code || 1);
});

try {
  await waitForRenderer();
  console.log(`[flowhub] 浏览器预览：${rendererUrl}/search.html`);
  console.log(`[flowhub] 配置页预览：${rendererUrl}/settings.html`);
  const electron = run(electronPath, [appDirectory, "--dev"], {
    env: { ...process.env, FLOWHUB_RENDERER_URL: rendererUrl }
  });
  electron.once("exit", (code) => stop(code || 0));
} catch (error) {
  console.error(`[flowhub] 开发模式启动失败：${error.message}`);
  stop(1);
}
