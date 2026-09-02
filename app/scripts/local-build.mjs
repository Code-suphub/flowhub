import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const appDirectory = resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(readFileSync(join(appDirectory, "package.json"), "utf8"));
const installRequested = process.argv.includes("--install");
const buildArguments = process.argv.slice(2).filter((argument) => argument !== "--install");
const baseVersion = String(packageJson.version || "0.1.0").replace(/[^0-9.].*$/, "");
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const localVersion = `${baseVersion}-local.${stamp}`;
const configDirectory = mkdtempSync(join(tmpdir(), "flowhub-local-build-"));
const configPath = join(configDirectory, "tauri.local.json");

// Tauri merges this small override with tauri.conf.json. The prerelease marker
// keeps local iterations distinct, so the stable GitHub updater can later offer
// the official release even when its version is numerically lower.
writeFileSync(configPath, `${JSON.stringify({ version: localVersion }, null, 2)}\n`);

try {
  const result = spawnSync(process.execPath, [join(appDirectory, "scripts", "tauri-build.mjs"), "--config", configPath, ...buildArguments], {
    cwd: appDirectory,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  const appPath = join(appDirectory, "src-tauri", "target", "release", "bundle", "macos", "FlowHub.app");
  if (existsSync(appPath)) {
    console.log(`本地迭代包已生成：${appPath}\n版本：${localVersion}`);
    if (installRequested) {
      if (process.platform !== "darwin") throw new Error("本地自动安装目前仅支持 macOS");
      const targetPath = "/Applications/FlowHub.app";
      if (existsSync(targetPath)) {
        const removed = spawnSync("osascript", ["-e", `tell application \"Finder\" to delete POSIX file \"${targetPath}\"`], { stdio: "inherit" });
        if ((removed.status ?? 1) !== 0) throw new Error("无法移除旧版 FlowHub，请先退出正在运行的应用");
      }
      const copied = spawnSync("ditto", [appPath, targetPath], { stdio: "inherit" });
      if ((copied.status ?? 1) !== 0) throw new Error("本地 FlowHub 安装失败");
      spawnSync("open", ["-a", targetPath], { stdio: "inherit" });
      console.log(`本地迭代版已安装并启动：${targetPath}`);
    }
  }
} finally {
  rmSync(configDirectory, { recursive: true, force: true });
}
