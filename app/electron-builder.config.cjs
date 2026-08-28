const hasAll = (...names) => names.every((name) => String(process.env[name] || "").trim());

const shouldNotarize = hasAll("APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID")
  || hasAll("APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER")
  || hasAll("APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE");
const shouldPublishToGitHub = process.env.FLOWHUB_PUBLISH === "1";
const [githubOwner, githubRepo] = String(process.env.GITHUB_REPOSITORY || "").split("/", 2);

module.exports = {
  appId: "cn.ac.camellia.flowhub",
  productName: "FlowHub",
  directories: {
    output: "dist",
    buildResources: "build"
  },
  files: [
    "main.js",
    "preload.js",
    "clipboard-store.js",
    "config-persistence.js",
    "update-service.js",
    "native/**/*",
    "plugins/**/*",
    "ui/**/*",
    "package.json"
  ],
  asar: true,
  asarUnpack: [
    "node_modules/sql.js/dist/*.wasm"
  ],
  extraResources: [
    {
      from: "../config.json",
      to: "config.json"
    }
  ],
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  mac: {
    category: "public.app-category.productivity",
    hardenedRuntime: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    notarize: shouldNotarize,
    extendInfo: {
      LSUIElement: true,
      NSAppleEventsUsageDescription: "FlowHub 使用系统自动化能力将选中的内容粘贴到上一应用。"
    }
  },
  dmg: {
    title: "FlowHub ${version}"
  },
  ...(shouldPublishToGitHub
    ? {
        publish: {
          provider: "github",
          releaseType: "release",
          channel: "latest",
          publishAutoUpdate: true,
          ...(githubOwner && githubRepo ? { owner: githubOwner, repo: githubRepo } : {})
        }
      }
    : {})
};
