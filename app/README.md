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

macOS 包固定使用 `FlowHub Local Development` 代码签名身份，以便本地迭代包和 GitHub
发布包保持相同的 Designated Requirement。该自签名证书仅适合已信任证书的开发机器；其他
Mac 仍可能出现 Gatekeeper 提示。Tauri 更新包签名与 macOS 应用代码签名相互独立。
证书只需在运行安装包的 Mac 上设为信任；GitHub runner 仅导入证书完成签名。

## GitHub 自动发布与更新

在 GitHub 仓库中配置以下 Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：Tauri 更新签名。
- `FLOWHUB_MACOS_CERTIFICATE`：`FlowHub Local Development` 的 PKCS#12 文件经 Base64 编码后的内容。
- `FLOWHUB_MACOS_CERTIFICATE_PASSWORD`：上述 PKCS#12 文件的密码。

自签名证书及私钥不得提交到仓库。本地钥匙串与 GitHub Actions 必须使用同一个证书，
否则 macOS 辅助功能授权无法在本地包和 GitHub 发布包之间复用。

同步修改以下三处版本号后，推送同名标签：

- `app/package.json`
- `app/src-tauri/Cargo.toml`
- `app/src-tauri/tauri.conf.json`

```bash
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release-macos.yml` 会测试并构建 Apple Silicon 和 Intel 两套 DMG，上传签名后的更新包与 `latest.json`。已安装版本启动 5 秒后自动检查 GitHub Release，也可在“配置管理 → 通用设置”中手动检查、下载并重启安装。

### 本地迭代与回退

本机开发可以使用本地 Release 构建，不需要修改三个正式版本号文件：

```bash
npm run build:local
```

该命令会生成带有 `-local.YYYYMMDDHHmmss` 标记的版本，并复用本机 Tauri 更新签名密钥。安装本地包后，设置页会显示“本地迭代版 · 可回退 GitHub Release”；点击“检查正式版”即可检查并安装 GitHub 最新正式版本。正式版本仍通过 `v*` 标签发布，不会被本地迭代包覆盖。

如果希望构建完成后直接替换 `/Applications/FlowHub.app` 并启动，可使用：

```bash
npm run build:local:install
```

## 机器管理插件

机器管理已迁至同级独立 Git 仓库 `flowhub-machines-plugin`，页面、SSH 后端和测试都在插件仓库中维护。FlowHub 只保留通用插件加载器。首次迁移需要更新宿主，然后在「插件市场」选择已构建的插件仓库目录安装。

在插件仓库运行 `npm run dev` 使用模拟数据调试，运行 `npm run build` 构建独立后端；之后在插件市场重新加载，无需重编译 FlowHub。宿主的 `npm run dev:machines` 是同级仓库开发命令的快捷入口。原机器配置和历史数据沿用，详见[独立插件协议](../docs/plugin-runtime.md)。市场支持先配置本地目录或 HTTPS 仓库，再扫描安装。线上独立插件包需要签名、公钥和平台信息，旧声明式线上包需要升级为 schema 2。

## 核心能力

- 网页目录：分类、搜索、编辑并持久化到 SQLite。
- 本机应用：扫描 macOS 应用目录，显示原生图标并启动。
- 剪贴板：监听文本、图片和文件，SHA-256 去重，搜索后自动粘贴。
- 备忘命令：统一搜索 MySQL、Docker、Bash、Git 和 Kubernetes 等内容。
- 常用/最近：打开应用或网页后写入 SQLite，并按时间衰减计算热度。
- 系统集成：全局快捷键、失焦隐藏、单实例、登录时启动和应用内更新。
# 控制本地构建磁盘占用

开发与测试默认关闭 Rust 调试符号和增量编译，测试仍保留断言。需要调试符号时可临时设置 `CARGO_PROFILE_DEV_DEBUG=1`。Release 配置不受影响。

本地安装 `npm run build:local:install` 默认只生成 app 和更新归档，不生成 DMG；正式分发构建保持原流程。不要同时运行完整测试与 Release 构建，避免链接临时文件叠加。

需要回收缓存时，在 app 目录运行 `cargo clean --manifest-path src-tauri/Cargo.toml --profile dev`。它只删除开发/测试构建产物，保留 Release 产物、已安装应用和用户数据；下一次测试会重新编译依赖。
