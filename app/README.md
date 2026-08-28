# FlowHub 桌面启动器

FlowHub 是基于 Tauri 2 的 macOS 本地启动器。默认按 **Option + Space** 呼出浮窗，可搜索应用、网页目录、剪贴板历史和备忘命令。

## 开发与运行

需要 Node.js 22+、Rust stable 和 Xcode Command Line Tools。

```bash
cd app
npm install
npm start
```

App 默认不显示 Dock 图标或常驻主窗口。启动后按 **Option + Space** 呼出；搜索结果用方向键选择，按 `Enter` 执行，按 `Esc` 关闭。

只预览前端页面时可运行 `npm run dev:web`，但浏览器不具备全局快捷键、剪贴板监听、打开本机应用等原生能力。

## 本地数据

首次启动会把旧 Electron 版或 Tauri 验证版的数据安全复制到：

```text
~/Library/Application Support/FlowHub/
```

- `config.json` 保存全局和插件配置。
- `clipboard/weborg.db` 是网页目录、使用记录和剪贴板历史的 SQLite 主存储。
- `clipboard/images/` 保存剪贴板图片副本。
- `config-location.json` 只记录自定义配置文件位置。

设置页可以切换配置文件和数据目录。切换到空目录时会复制现有数据，旧目录保留作为可恢复备份。仓库根目录 `config.json` 中的网页 `items` 保持为空，真实网页目录仅存入 SQLite。

## 测试与安装包

```bash
cd app
npm test
npm run build
```

本机构建会从 `~/.tauri/flowhub.key` 读取 Tauri 更新签名私钥，并从 `~/.tauri/flowhub.key.password` 读取密码。也可使用 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PATH` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 指定。私钥和密码都不能提交到仓库；丢失后已安装版本将无法验证后续更新。

Apple Silicon 产物默认位于：

```text
src-tauri/target/release/bundle/macos/FlowHub.app
src-tauri/target/release/bundle/dmg/FlowHub_0.1.0_aarch64.dmg
```

目前使用 ad-hoc 签名，不需要 Apple 开发者账号；其他 Mac 首次打开可能出现 Gatekeeper 提示。Tauri 更新包签名与 Apple Developer ID 签名相互独立。

## GitHub 自动发布与更新

在 GitHub 仓库中配置 Actions Secret `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，值分别是本机 `~/.tauri/flowhub.key` 与 `~/.tauri/flowhub.key.password` 的完整内容。

同步修改以下三处版本号后，推送同名标签：

- `app/package.json`
- `app/src-tauri/Cargo.toml`
- `app/src-tauri/tauri.conf.json`

```bash
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release-macos.yml` 会测试并构建 Apple Silicon 和 Intel 两套 DMG，上传签名后的更新包与 `latest.json`。已安装版本启动 5 秒后自动检查 GitHub Release，也可在“配置管理 → 通用设置”中手动检查、下载并重启安装。

## 核心能力

- 网页目录：分类、搜索、编辑并持久化到 SQLite。
- 本机应用：扫描 macOS 应用目录，显示原生图标并启动。
- 剪贴板：监听文本、图片和文件，SHA-256 去重，搜索后自动粘贴。
- 备忘命令：统一搜索 MySQL、Docker、Bash、Git 和 Kubernetes 等内容。
- 常用/最近：打开应用或网页后写入 SQLite，并按时间衰减计算热度。
- 系统集成：全局快捷键、失焦隐藏、单实例、登录时启动和应用内更新。
