import { readFile, writeFile } from "node:fs/promises";

const [metadataPath, repository, tag] = process.argv.slice(2);
if (!metadataPath || !repository || !tag) {
  console.error("用法: node scripts/fix-updater-metadata.mjs <latest.json> <owner/repo> <tag>");
  process.exit(1);
}

const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const names = {
  "darwin-aarch64": `FlowHub_${metadata.version}_aarch64.app.tar.gz`,
  "darwin-aarch64-app": `FlowHub_${metadata.version}_aarch64.app.tar.gz`,
  "darwin-x86_64": `FlowHub_${metadata.version}_x64.app.tar.gz`,
  "darwin-x86_64-app": `FlowHub_${metadata.version}_x64.app.tar.gz`
};

for (const [platform, entry] of Object.entries(metadata.platforms || {})) {
  const name = names[platform];
  if (name && entry) entry.url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
}

await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
