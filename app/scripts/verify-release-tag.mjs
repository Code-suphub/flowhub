import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(scriptDirectory, "..", "package.json"), "utf8"));
const tag = String(process.argv[2] || process.env.GITHUB_REF_NAME || "").trim();
const expectedTag = `v${packageJson.version}`;

if (!tag) {
  console.error("无法确认发布标签：请传入标签名，或在 GitHub Actions 标签构建中运行。");
  process.exit(1);
}

if (tag !== expectedTag) {
  console.error(`发布标签 ${tag} 与 app/package.json 版本不一致，应为 ${expectedTag}。`);
  process.exit(1);
}

console.log(`发布标签校验通过：${tag}`);
