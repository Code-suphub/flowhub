# 宿主 React 迁移

## 已完成（第一批）

- React + TypeScript + Vite + Tailwind 构建入口：`app/src/`。
- 插件市场：发现、已安装、来源、来源编辑、安装／卸载确认。删除旧 DOM 脚本和专用 CSS。
- 宿主设置：分类导航由 React 接管；`FlowHubSettingsNavigation` 只桥接当前分类，不复制配置状态。删除旧导航 HTML、事件分支和样式。
- 宿主 React 共享控件：Button、Input、Field、Tabs、Dialog。导航帮助继续使用宿主现有 `help-tooltip.js`。

## 后续批次

- [ ] 提取设置状态与保存 API 的类型化接口，保留草稿、重置、错误处理。
- [ ] 迁移基础、搜索入口（含拖拽排序）、通知。
- [ ] 迁移网络、菜单栏与权限状态。
- [ ] 迁移数据与诊断、更新；验证配置历史、导入导出与更新渠道。
- [ ] 接管侧栏及剩余宿主设置面板，删除被替代的 settings.js 渲染与事件。

这不是“宿主设置全部迁移完成”：表单和配置存储仍由旧控制器负责，迁移按面板逐项验收。

## 构建与验证

`cd app && npm run build:ui` 生成 `ui/react/host.js`、`host.css`，不提交产物。Tauri beforeBuildCommand 与 dev:web 前置脚本都会生成它们，CI 不依赖旁边的插件仓库。React 源码迭代时另开 `npm run dev:ui` 持续重建；原有 Vite 预览服务器监控产物并刷新。

不启用全局 Tailwind preflight，保留宿主主题变量与 CSP。生成经典 IIFE 而不是 file:// 下需要 CORS 的模块入口。新组件放宿主共享层；跨仓库组件发布机制未迁移，不能宣称宿主已使用插件公共包。

验证：`npm run typecheck`、`npm run test:react`、`npm run test:ui`、`npm run test:preview`、`npm test`。React 行为测试使用隔离的模拟 API，不修改用户插件或配置；桌面权限与真实安装需另行验收。
