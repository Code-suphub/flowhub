# 宿主 React 迁移

## 迁移范围

本任务覆盖 FlowHub 桌面宿主全部交互页面，不包括 Chrome 扩展及冻结的 legacy 管理台。Rust/Tauri、SQLite 和插件隔离协议不更换技术栈。

| 页面 | React 源码 | 挂载点 |
| --- | --- | --- |
| 搜索窗口 | `app/src/search` | `search-root` |
| 宿主设置 | `app/src/settings` | `settings-root` |
| 插件市场 | `app/src/market` | `market-root` |
| 菜单栏面板 | `app/src/surfaces/MenuBarPanel.tsx` | `menu-bar-root` |
| 插件状态 | `app/src/surfaces/PluginStatus.tsx` | `plugin-status-root` |
| 插件详情 | `app/src/surfaces/PluginDetail.tsx` | `plugin-detail-root` |
| 桌面组件画布 | `app/src/canvas` | `canvas-root` |

`index.html` 仅负责跳转搜索窗口。HTML 保留资源加载与挂载点，业务界面由 React 渲染。共享控件为 `app/src/shared` 的 Button、Input、Field、Tabs、Dialog、Select、Switch、Tooltip/Help。

搜索异步业务控制器、纯工具算法、原生／浏览器适配层、主题桥和插件安全桥继续使用已有 JavaScript；它们不再拼接页面 UI。保留这些模块不等于保留旧表单或隐藏旧界面。原生入口通过显式桥调用 React 状态，不依赖模块私有变量变成全局。

## 验收清单

- [x] 七个桌面页面使用 React + TypeScript，复用公共控件与语义主题。
- [x] 删除替换后的旧 DOM 渲染、事件绑定、专用 CSS 和未使用的旧控件。
- [x] 搜索来源、工具视图、分页、焦点、原生诊断桥及卸载清理。
- [x] 画布布局、拖拽／缩放、菜单、编辑器 ready/save 与隔离 RPC。
- [x] 设置草稿／路径切换、导入导出、历史、排序与原生入口隔离行为回归。
- [x] 全量宿主测试及资源完整性检查。

真实安装后的系统权限、更新安装和 WebKit 原生压测需要单独执行；隔离模拟测试不代表已经操作或验收用户的真实数据。

## 构建与验证

`cd app && npm run build:ui` 生成 `ui/react/host.js`、`host.css`，不提交产物。Tauri beforeBuildCommand 与 dev:web 前置脚本都会生成它们，CI 不依赖旁边的插件仓库。React 源码迭代时另开 `npm run dev:ui` 持续重建；原有 Vite 预览服务器监控产物并刷新。

不启用全局 Tailwind preflight，保留宿主主题变量与 CSP。生成经典 IIFE 而不是 file:// 下需要 CORS 的模块入口。新组件放宿主共享层；跨仓库组件发布机制未迁移，不能宣称宿主已使用插件公共包。

验证：`npm run typecheck`、`npm run test:react`、`npm run test:ui`、`npm run test:preview`、`npm test`。React 行为测试使用隔离的模拟 API，不修改用户插件或配置；桌面权限与真实安装需另行验收。
