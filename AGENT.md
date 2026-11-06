# FlowHub 项目协作规范

本文件是项目规则的唯一正文；`AGENTS.md`（Codex）与 `CLAUDE.md`（Claude Code）均链接到此文件，修改规则时只编辑本文件。

## 项目目标

FlowHub 是一个 macOS 本地启动器，提供应用、网页目录、剪贴板历史和命令备忘录搜索。优先保证启动速度、输入响应和本地数据安全。

## 代码结构

- `app/`：Tauri 桌面应用（宿主）。`app/ui/` 页面与浏览器预览适配层、`app/src-tauri/` macOS 原生能力、`app/scripts/` 构建与本地迭代脚本。
- `extension/`：Chrome 扩展（side panel、popup、new tab 与页面内浮窗）。
- `legacy/`：已冻结的旧 Web 管理台 `server.mjs` + `index.html` 及其测试，只支持 schema 1 目录。
- `docs/`：`architecture/` 现行架构（按主题分组）与 `tasks/` 任务清单。一次性排查、性能测量与版本说明不入库，记录留在提交信息与 git 历史中。
- `.github/workflows/`：GitHub Actions 正式构建与发布。
- `config.json`：本地配置示例，legacy server 与浏览器预览的数据来源。

## 修改规范

- 修改前先检查工作区状态，保留用户已有改动，不使用破坏性的 `git reset --hard` 或大范围删除。
- 文件编辑使用补丁方式；不要用临时脚本覆盖源码文件。
- 搜索代码优先使用 `rg`，并在修改后执行 `git diff --check`。
- 搜索输入路径不能做同步数据库、磁盘扫描或原生图标扫描；异步结果应合并刷新，避免逐个结果到达时重复重绘。
- 不在普通输入重绘中调用会触发布局计算的操作（例如无条件 `scrollIntoView`）；键盘选中态优先使用轻量 DOM 更新。
- 剪贴板类型通过界面按钮切换；裸 `←/→` 保留给输入框光标移动。只有明确的范围快捷键才拦截方向键。
- 浏览器预览必须保持只读语义；Tauri 原生适配层与浏览器适配层的行为差异要显式处理。
- 全局主题由 `ui/shared/theme.js` 管理 `flowhub.theme`（system/light/dark），`palette.css` 提供语义颜色。所有应用入口加载这两份资源，iframe 通过 `flowhub:theme-ready` / `flowhub:theme` 跟随宿主；主题消息不授予插件业务权限。新增样式使用 `--fh-*` 变量。

## 前端技术栈与界面约定

- 新增及明确纳入迁移范围的管理页面采用 React + TypeScript + Vite，使用 Tailwind CSS 编写布局与响应式样式；Rust/Tauri 继续负责原生能力与敏感数据。不要为迁移顺带重写未纳入范围的页面。
- React 页面优先复用公共组件。插件使用插件仓库的 `@flowhub/plugin-common/react`；宿主使用 `app/src/shared` 的 React 控件，`app/ui/shared` 保留主题、原生适配和兼容桥。缺少能力先补公共层，不在页面中复制按钮、弹窗、下拉、帮助提示的交互实现。
- 宿主 React 源码入口为 `app/src/main.tsx`，公共 React 控件在 `app/src/shared`；帮助提示复用公共 `Help`。`npm run build:ui` 生成不入库的 `app/ui/react` 资源，Tauri 构建和 dev:web 启动前会自动构建；开发时用 `npm run dev:ui` 持续重建。每个 React 页面必须同时引用产物 JS 与 CSS；HTML 只保留挂载点和所需桥接脚本。宿主构建不能依赖旁边的插件仓库路径。
- 说明文字使用公共悬浮提示／帮助组件，支持鼠标悬浮和键盘聚焦；长说明可用帮助弹窗。验证错误、运行状态、不可逆操作警告不能藏进提示里。
- Tab 或当前导航已表明用途时，不重复同名大标题、英文眉题和导语。主界面保留操作所需标签与状态，避免多层卡片、超宽控件和无意义留白。
- Tailwind 负责布局，`--fh-*` 语义变量负责主题；不要在业务页面写死深浅配色。渐进迁移的 island 不启用全局 preflight，避免影响旧页面。
- 技术栈迁移必须替换并删除被接管的旧 DOM 拼接、事件绑定和专用 CSS，不能只隐藏旧界面。保持预览只读、插件隔离、权限和凭证处理边界不变。
- 验收包括类型检查、行为测试、产物资源完整性、深浅主题与窄屏检查。公共样式或组件接入不等于完成 React 迁移，进度需按实际入口说明。

## 测试与验证

涉及代码或构建脚本时，在提交前至少执行：

```bash
npm test          # 仓库根：legacy server 与 legacy 目录契约
cd app
npm test
git diff --check
```

涉及页面交互时，使用本地 Web 页面验证真实点击、输入、键盘事件和控制台错误。涉及性能时检查输入期间的布局耗时和长任务，不只依赖静态代码判断。

仅修改文档或规则入口链接时，检查命令与当前代码是否一致、相对链接与符号链接是否有效，并执行 `git diff --check`，无需重跑业务测试。

## 构建与更新通道

- GitHub 正式版：修改 `app/package.json`、`app/src-tauri/Cargo.toml`、`app/src-tauri/tauri.conf.json` 的版本号，创建同名 `v*` 标签并推送；Actions 负责构建 Apple Silicon 和 Intel 包。
- 本地迭代版：运行 `cd app && npm run build:local`，生成带 `-local.YYYYMMDDHHmmss` 标记的 Release 包；需要替换并启动本机应用时使用 `npm run build:local:install`。
- 本地版本必须使用与 GitHub 正式版相同的 Tauri updater 签名密钥，不能用未签名调试包冒充更新包。
- 本地迭代版本可在设置页检查 GitHub 正式版并回退；不要把本地迭代包发布为正式 Release。
- 发布前确认 GitHub Actions 的测试、版本校验、签名和双架构构建全部通过。

## Git 规范

- 提交信息使用简洁的 Conventional Commits 风格，例如 `perf: ...`、`fix: ...`、`feat: ...`。
- 推送前确认提交内容、远程仓库和目标标签；推送发布标签会触发 GitHub Actions，应在用户明确要求时执行。
- 不提交 `node_modules`、构建产物、数据库、日志或本地签名私钥。

## CLI

- 验证优先选择能覆盖目标的项目 CLI、后端测试或隔离页面驱动；涉及正式安装版、系统输入和窗口行为时补原生验收。具体入口、示例和取证要求见 [CLI 与原生验收](docs/architecture/testing/cli-verification.md)。
- 在 `app/` 执行 `node scripts/dev/flowhub-cli.mjs help` 查看数据与诊断 CLI。HTTP 配置命令默认连接 `http://127.0.0.1:4173`，可用 `FLOWHUB_URL` 指定旧服务；它不操作桌面 SQLite 配置，也不安装插件或点击原生按钮。`config set`／`config replace` 会写配置，`diagnose`／`monitor sample` 会写诊断文件，`monitor enable`／`disable`／`clear` 也有写入，不能当作纯读取。
- 当前 checkout 若包含 `app/scripts/dev/flowhub-ui-test.mjs`，先读取其配套使用说明并执行 `help`。此驱动只连接专用测试构建与隔离数据目录；`synthetic-dom`、`isTrusted=false` 的结果不能证明普通安装版、实际键盘路由、IME、原生 Tab、全局焦点或多屏通过。缺少该脚本时不能假定入口已合入当前分支。
- 正常安装版可使用环境已有的 `toolkit desktop` 或 Computer Use 读取窗口、AX 与截图，再操作真实控件。CLI 发起的原生输入仍可能占用系统桌面；后台读取、隔离 DOM 驱动和全局输入要区分，不承诺多会话键鼠操作互不影响。
- 桌面 CLI 先读当前后端指南，写操作先预演；用新读取的窗口、控件和坐标，不固化 PID／窗口 ID。操作后读回业务结果；退出码、`confirmed` 或截图差分不单独代表成功。超时／疑似未生效时先检查实际状态，不自动重放输入、安装、保存或提交。
- 用户已授权的替换按既有授权完成，不反复请求同一授权。只更新目标范围；不能因目录框自动化失败而直接改写运行中宿主的注册文件、放宽权限或顺带重启整个应用。锁屏、用户或其他会话打断输入时，该轮标记受干扰；继续不依赖桌面的检查，必要时请求具体的人工协助。
- 正式替换前备份目标包和注册信息；替换后核对注册版本／目录、包指纹、实际进程路径及界面状态。没有替换并加载的页面不能称为安装版实测；新改动／新构建不能继承旧包的通过结论。
- CLI 输出保持 JSON 兼容。验收记录分别列出自动检查、隔离宿主、正式安装版和待验项，记录提交／构建版本、驱动方式、结果与证据路径；截图、会话 token、用户数据和机器日志保留在 Git 外。
