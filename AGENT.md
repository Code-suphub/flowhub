# FlowHub 项目协作规范

## 项目目标

FlowHub 是一个 macOS 本地启动器，提供应用、网页目录、剪贴板历史和命令备忘录搜索。优先保证启动速度、输入响应和本地数据安全。

## 代码结构

- `app/ui/`：搜索页、设置页和浏览器预览适配层。
- `app/src-tauri/`：macOS 原生能力、窗口、剪贴板和更新器。
- `app/scripts/`：构建、发布校验和本地迭代脚本。
- `.github/workflows/`：GitHub Actions 正式构建与发布。
- `config.json`：本地配置示例及开发预览数据来源。

## 修改规范

- 修改前先检查工作区状态，保留用户已有改动，不使用破坏性的 `git reset --hard` 或大范围删除。
- 文件编辑使用补丁方式；不要用临时脚本覆盖源码文件。
- 搜索代码优先使用 `rg`，并在修改后执行 `git diff --check`。
- 搜索输入路径不能做同步数据库、磁盘扫描或原生图标扫描；异步结果应合并刷新，避免逐个结果到达时重复重绘。
- 不在普通输入重绘中调用会触发布局计算的操作（例如无条件 `scrollIntoView`）；键盘选中态优先使用轻量 DOM 更新。
- 剪贴板类型通过界面按钮切换；裸 `←/→` 保留给输入框光标移动。只有明确的范围快捷键才拦截方向键。
- 浏览器预览必须保持只读语义；Tauri 原生适配层与浏览器适配层的行为差异要显式处理。

## 测试与验证

在提交前至少执行：

```bash
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
