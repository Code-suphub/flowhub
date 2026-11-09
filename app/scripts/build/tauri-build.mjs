import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const environment = { ...process.env };
// Pin the certificate used by the published macOS apps. A same-named
// certificate would produce a different designated requirement.
const releaseSigningIdentity = "773FDFC34278DA4A11FB069DB50FCE57AABFEEBA";
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

if (process.platform === "darwin" && environment.APPLE_SIGNING_IDENTITY === undefined && !environment.APPLE_CERTIFICATE) {
  // Include self-signed identities. codesign accepts the exact fingerprint
  // even when security find-identity -v omits it.
  const identities = spawnSync("/usr/bin/security", ["find-identity", "-p", "codesigning"], { encoding: "utf8" });
  if (identities.status !== 0 || !identities.stdout.includes(releaseSigningIdentity)) {
    console.error("本机钥匙串中缺少与 GitHub 发布版一致的 FlowHub Local Development 签名身份。请导入原签名证书及私钥，或明确设置 APPLE_SIGNING_IDENTITY 后重试。");
    process.exit(1);
  }
  // Both Tauri and the bundled resource-monitor helper read this variable.
  environment.APPLE_SIGNING_IDENTITY = releaseSigningIdentity;
}

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(command, ["exec", "tauri", "build", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
