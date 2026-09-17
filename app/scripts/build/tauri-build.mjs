import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const environment = { ...process.env };
const localKey = join(homedir(), ".tauri", "flowhub.key");
const localPassword = join(homedir(), ".tauri", "flowhub.key.password");
if (!environment.TAURI_SIGNING_PRIVATE_KEY && environment.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  environment.TAURI_SIGNING_PRIVATE_KEY = readFileSync(environment.TAURI_SIGNING_PRIVATE_KEY_PATH, "utf8");
}
if (!environment.TAURI_SIGNING_PRIVATE_KEY && existsSync(localKey)) {
  environment.TAURI_SIGNING_PRIVATE_KEY = readFileSync(localKey, "utf8");
}
if (!environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD && existsSync(localPassword)) {
  environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(localPassword, "utf8").trim();
}

if (!environment.TAURI_SIGNING_PRIVATE_KEY && !environment.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  console.error("缺少 Tauri 更新私钥。请设置 TAURI_SIGNING_PRIVATE_KEY，或将本机私钥放在 ~/.tauri/flowhub.key。");
  process.exit(1);
}

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["tauri", "build", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
