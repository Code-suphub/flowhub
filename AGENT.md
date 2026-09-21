# FlowHub 项目协作规范

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
- React 页面优先复用公共组件。插件使用插件仓库的 `@flowhub/plugin-common/react`；宿主原生页面使用 `app/ui/shared` 的现有组件。缺少能力先补公共层，不在页面中复制按钮、弹窗、下拉、帮助提示的交互实现。
- 说明文字使用公共悬浮提示／帮助组件，支持鼠标悬浮和键盘聚焦；长说明可用帮助弹窗。验证错误、运行状态、不可逆操作警告不能藏进提示里。
- Tab 或当前导航已表明用途时，不重复同名大标题、英文眉题和导语。主界面保留操作所需标签与状态，避免多层卡片、超宽控件和无意义留白。
- Tailwind 负责布局，`--fh-*` 语义变量负责主题；不要在业务页面写死深浅配色。渐进迁移的 island 不启用全局 preflight，避免影响旧页面。
- 技术栈迁移必须替换并删除被接管的旧 DOM 拼接、事件绑定和专用 CSS，不能只隐藏旧界面。保持预览只读、插件隔离、权限和凭证处理边界不变。
- 验收包括类型检查、行为测试、产物资源完整性、深浅主题与窄屏检查。公共样式或组件接入不等于完成 React 迁移，进度需按实际入口说明。

## 测试与验证

在提交前至少执行：

```bash
npm test          # 仓库根：legacy server 与 legacy 目录契约
cd app
npm test
git diff --check
```

涉及页面交互时，使用本地 Web 页面验证真实点击、输入、键盘事件和控制台错误。涉及性能时检查输入期间的布局耗时和长任务，不只依赖静态代码判断。

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

- `npm run cli -- help` displays available data-management commands.
- The CLI talks to `http://127.0.0.1:4173` by default; override with `FLOWHUB_URL`.
- `config set` and `config replace` are write operations; validate JSON before sending changes.
- Keep CLI output JSON-compatible so it can be piped to `jq` or other scripts.
