# 页面与源码对应

这些是可编辑的设计基线，不是生产运行时，也不代表原生功能验收。

| 页面 / 状态 | Plasmic 路径 | 仓库 | 源入口 / 实现 | 数据方式 |
| --- | --- | --- | --- | --- |
| 启动器 · 全部 | /launcher | Code-suphub/flowhub | app/src/search/index.tsx | 只读合成预览 |
| 启动器 · 剪贴板 | /launcher/clipboard | Code-suphub/flowhub | app/src/search/Results.tsx | 只读合成预览 |
| 启动器 · 应用 | /launcher/applications | Code-suphub/flowhub | app/src/search/Results.tsx | 只读合成预览 |
| 启动器 · 网页 | /launcher/web | Code-suphub/flowhub | app/src/search/Results.tsx | 只读合成预览 |
| 启动器 · 命令备忘录 | /launcher/memo | Code-suphub/flowhub | app/src/search/Results.tsx | 只读合成预览 |
| 设置 · 通用设置 | /settings/core | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · 外观 | /settings/appearance | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · 数据与诊断 | /settings/data | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · 版本与更新 | /settings/updates | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · 搜索 | /settings/search | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · 菜单栏 | /settings/menubar | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · 桌面组件 | /settings/canvas | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · 网页目录 | /settings/web | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · 应用 | /settings/app | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · 剪贴板 | /settings/clipboard | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · 备忘录 | /settings/memo | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · 工具 | /settings/tools | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 插件市场 · 发现 | /market | Code-suphub/flowhub | app/ui/plugin-market.html | 只读合成预览 |
| 插件市场 · 已安装 | /market/installed | Code-suphub/flowhub | app/src/market/Market.tsx | 只读合成预览 |
| 插件状态 | /plugin-status | Code-suphub/flowhub | app/ui/plugin-status.html | 只读合成预览 |
| 菜单栏图标 | /menu-bar | Code-suphub/flowhub | app/ui/menu-bar-panel.html | 只读合成预览 |
| 设置 · 搜索设置面板 | /settings/dialog/search | Code-suphub/flowhub | app/src/settings/SettingsSearch.tsx | 只读合成预览 |
| 设置 · 更多操作 | /settings/dialog/more | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 设置 · JSON 配置 | /settings/dialog/json | Code-suphub/flowhub | app/src/settings/index.tsx | 只读合成预览 |
| 启动器 · 剪贴板预览 | /launcher/clipboard/preview | Code-suphub/flowhub | app/src/search/Preview.tsx | 只读合成预览 |
| 启动器 · 操作面板 | /launcher/actions | Code-suphub/flowhub | app/src/search/ActionPanel.tsx | 只读合成预览 |
| 插件市场 · 插件详情 | /market/dialog/details | Code-suphub/flowhub | app/src/market/PluginDetails.tsx | 只读合成预览 |
| 插件市场 · 来源设置 | /market/dialog/sources | Code-suphub/flowhub | app/src/market/SourceDialog.tsx | 只读合成预览 |
| 浏览器扩展 · 新标签 | /extension/newtab | Code-suphub/flowhub | extension/src/app.js | 只读合成预览 |
| 浏览器扩展 · 侧边栏 | /extension/side_panel | Code-suphub/flowhub | extension/src/app.js | 只读合成预览 |
| 浏览器扩展 · 弹出页 | /extension/popup | Code-suphub/flowhub | extension/src/app.js | 只读合成预览 |
| 桌面组件 · 紧凑状态条 | /canvas/compact | Code-suphub/flowhub | app/src/canvas/CompactBar.tsx | 只读合成预览 |
| 桌面组件 · 画布 | /canvas | Code-suphub/flowhub | app/src/canvas/Canvas.tsx | 只读合成预览 |
| 桌面组件 · 操作菜单 | /canvas/actions | Code-suphub/flowhub | app/src/canvas/Canvas.tsx | 只读合成预览 |
| 桌面组件 · 紧凑入口设置 | /canvas/compact-settings | Code-suphub/flowhub | app/src/canvas/CompactBar.tsx | 只读合成预览 |
| 脚本认证 · 来源提示 | /script-alert | Code-suphub/flowhub | app/src/surfaces/ScriptAlert.tsx | 只读合成预览 |
| 插件工作区 · 插件导航条 | /workspace/dock | Code-suphub/flowhub | app/ui/plugin-workspace.html | synthetic-native-adapter |
| 插件工作区 · 更多插件 | /workspace/panel | Code-suphub/flowhub | app/ui/plugin-workspace.html | synthetic-native-adapter |
| 脚本认证 · 合成来源 | /script-alert/identified | Code-suphub/flowhub | app/ui/script-alert.html | synthetic-native-adapter |
| 桌面组件 · 添加组件 | /canvas/add | Code-suphub/flowhub | app/ui/plugin-canvas.html | synthetic-native-adapter |
| 外设中心 · 设备 | /plugins/device-center | Code-suphub/flowhub-plugins | plugins/device-center/src/App.tsx | standalone-plugin-demo |
| 外设中心 · 供电 | 组件 | Code-suphub/flowhub-plugins | plugins/device-center/src/App.tsx | standalone-plugin-demo |
| 外设中心 · 事件 | 组件 | Code-suphub/flowhub-plugins | plugins/device-center/src/App.tsx | standalone-plugin-demo |
| 外设中心 · Widget 卡片 | 组件 | Code-suphub/flowhub-plugins | plugins/device-center/ui/widget-card.html | standalone-plugin-demo |
| 外设中心 · Widget 编辑器 | 组件 | Code-suphub/flowhub-plugins | plugins/device-center/ui/widget-editor.html | standalone-plugin-demo |
| 外设中心 · Widget 详情 | 组件 | Code-suphub/flowhub-plugins | plugins/device-center/ui/widget-detail.html | standalone-plugin-demo |
| 外设中心 · 设备详情 | 组件 | Code-suphub/flowhub-plugins | plugins/device-center/src/App.tsx | standalone-plugin-demo |
| Docker · 容器 | /plugins/docker | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | standalone-plugin-demo |
| Docker · Compose 项目 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | standalone-plugin-demo |
| Docker · 独立容器 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | standalone-plugin-demo |
| Docker · 镜像 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | standalone-plugin-demo |
| Docker · 卷 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | standalone-plugin-demo |
| Docker · 网络 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | standalone-plugin-demo |
| Docker · Widget 卡片 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/ui/widget-card.html | standalone-plugin-demo |
| Docker · Widget 编辑器 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/ui/widget-editor.html | standalone-plugin-demo |
| Docker · Widget 详情 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/ui/widget-detail.html | standalone-plugin-demo |
| 机器管理 · 机器 | /plugins/machines | Code-suphub/flowhub-plugins | plugins/machines/src/fleet/main.tsx | standalone-plugin-demo |
| 机器管理 · Widget 卡片 | 组件 | Code-suphub/flowhub-plugins | plugins/machines/ui/widget-card.html | standalone-plugin-demo |
| 机器管理 · Widget 详情 | 组件 | Code-suphub/flowhub-plugins | plugins/machines/ui/widget-detail.html | standalone-plugin-demo |
| 机器管理 · Widget 编辑器 | 组件 | Code-suphub/flowhub-plugins | plugins/machines/ui/widget-editor.html | standalone-plugin-demo |
| 机器管理 · 新增主机弹窗 | 组件 | Code-suphub/flowhub-plugins | plugins/machines/src/fleet/main.tsx | standalone-plugin-demo |
| 机器管理 · 监控设置弹窗 | 组件 | Code-suphub/flowhub-plugins | plugins/machines/src/fleet/main.tsx | standalone-plugin-demo |
| 机器管理 · 备份与恢复弹窗 | 组件 | Code-suphub/flowhub-plugins | plugins/machines/src/fleet/main.tsx | standalone-plugin-demo |
| 资源监控 · 应用与工具排行 | /plugins/resource-monitor | Code-suphub/flowhub-plugins | plugins/resource-monitor/src/App.tsx | standalone-plugin-demo |
| 资源监控 · Widget 卡片 | 组件 | Code-suphub/flowhub-plugins | plugins/resource-monitor/ui/widget-card.html | standalone-plugin-demo |
| 资源监控 · Widget 编辑器 | 组件 | Code-suphub/flowhub-plugins | plugins/resource-monitor/ui/widget-editor.html | standalone-plugin-demo |
| 资源监控 · Widget 详情 | 组件 | Code-suphub/flowhub-plugins | plugins/resource-monitor/ui/widget-detail.html | standalone-plugin-demo |
| 资源监控 · 应用进程详情 | 组件 | Code-suphub/flowhub-plugins | plugins/resource-monitor/src/App.tsx | standalone-plugin-demo |
| 资源监控 · 后台服务抽屉 | 组件 | Code-suphub/flowhub-plugins | plugins/resource-monitor/src/App.tsx | standalone-plugin-demo |
| 资源监控 · 自启动抽屉 | 组件 | Code-suphub/flowhub-plugins | plugins/resource-monitor/src/App.tsx | standalone-plugin-demo |
| 资源监控 · 访达扩展抽屉 | 组件 | Code-suphub/flowhub-plugins | plugins/resource-monitor/src/App.tsx | standalone-plugin-demo |
| 社交中心 · 会话工作台 | /plugins/social-hub | Code-suphub/flowhub-plugins | plugins/social-hub/src/App.tsx | standalone-plugin-demo |
| 社交中心 · OAuth 链接弹窗 | 组件 | Code-suphub/flowhub-plugins | plugins/social-hub/src/App.tsx | standalone-plugin-demo |
| 验证码 · 邮件验证码 | 组件 | Code-suphub/flowhub-plugins | plugins/twofa/src/App.tsx | standalone-plugin-demo |
| 验证码 · 账户编辑弹窗 | 组件 | Code-suphub/flowhub-plugins | plugins/twofa/src/App.tsx | standalone-plugin-demo |
| 验证码 · 导入账户弹窗 | 组件 | Code-suphub/flowhub-plugins | plugins/twofa/src/App.tsx | standalone-plugin-demo |
| Docker · 卷资源（合成连接） | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | real-compiled-ui-with-synthetic-api |
| Docker · 容器运行日志选项卡 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | real-compiled-ui-with-synthetic-api |
| Docker · 拉取镜像表单 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | real-compiled-ui-with-synthetic-api |
| Docker · 新建卷表单 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | real-compiled-ui-with-synthetic-api |
| Docker · 新建网络表单 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | real-compiled-ui-with-synthetic-api |
| Docker · 网络资源（合成连接） | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | real-compiled-ui-with-synthetic-api |
| Docker · 镜像资源（合成连接） | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | real-compiled-ui-with-synthetic-api |
| 机器管理 · 任务与会话 | 组件 | Code-suphub/flowhub-plugins | plugins/machines/src/fleet/main.tsx | real-compiled-ui-with-synthetic-api |
| 机器管理 · 执行记录 | 组件 | Code-suphub/flowhub-plugins | plugins/machines/src/fleet/main.tsx | real-compiled-ui-with-synthetic-api |
| 验证码 · 导入账户解析弹窗 | 组件 | Code-suphub/flowhub-plugins | plugins/twofa/src/App.tsx | real-compiled-ui-with-synthetic-api |
| 验证码 · 添加账户编辑弹窗 | 组件 | Code-suphub/flowhub-plugins | plugins/twofa/src/App.tsx | real-compiled-ui-with-synthetic-api |
| 验证码 · 现有账户编辑弹窗 | 组件 | Code-suphub/flowhub-plugins | plugins/twofa/src/App.tsx | real-compiled-ui-with-synthetic-api |
| 验证码 · 连接邮箱弹窗 | 组件 | Code-suphub/flowhub-plugins | plugins/twofa/src/App.tsx | real-compiled-ui-with-synthetic-api |
| 验证码 · 邮件验证码列表 · 已连接含验证码 | 组件 | Code-suphub/flowhub-plugins | plugins/twofa/src/App.tsx | real-compiled-ui-with-synthetic-api |
| 验证码 · 验证器主页面 · 稳定示例码 | /plugins/twofa | Code-suphub/flowhub-plugins | plugins/twofa/src/App.tsx | real-compiled-ui-with-synthetic-api |
| Docker · 容器详情 · 概览选项卡 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | real-compiled-ui-with-synthetic-api |
| Docker · 容器详情 · 终端选项卡 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | real-compiled-ui-with-synthetic-api |
| Docker · 容器详情 · 运行日志选项卡 | 组件 | Code-suphub/flowhub-plugins | plugins/docker/src/App.tsx | real-compiled-ui-with-synthetic-api |
| 外设中心 · ADB 电量设置 | /plugins/device-center/adb/settings | Code-suphub/flowhub-plugins | plugins/device-center/src/App.tsx | synthetic-api-with-real-react-components |
| 外设中心 · 手机资源与 CPU 曲线 | /plugins/device-center/adb/performance | Code-suphub/flowhub-plugins | plugins/device-center/src/App.tsx | synthetic-api-with-real-react-components |
| 外设中心 · 手机内存曲线 | /plugins/device-center/adb/history/memory | Code-suphub/flowhub-plugins | plugins/device-center/src/App.tsx | synthetic-api-with-real-react-components |
| 外设中心 · 手机存储曲线 | /plugins/device-center/adb/history/storage | Code-suphub/flowhub-plugins | plugins/device-center/src/App.tsx | synthetic-api-with-real-react-components |
| 外设中心 · K75 模式与预设 | /plugins/device-center/keyboard/presets | Code-suphub/flowhub-plugins | plugins/device-center/src/App.tsx | synthetic-api-with-real-react-components |
| 外设中心 · K75 USB 诊断 | /plugins/device-center/keyboard/diagnostics | Code-suphub/flowhub-plugins | plugins/device-center/src/App.tsx | synthetic-api-with-real-react-components |
| 资源监控 · 活跃足迹历史 | /plugins/resource-monitor/history/footprint | Code-suphub/flowhub-plugins | plugins/resource-monitor/src/App.tsx | real-readonly-react-with-synthetic-history |
| 资源监控 · CPU历史 | /plugins/resource-monitor/history/cpu | Code-suphub/flowhub-plugins | plugins/resource-monitor/src/App.tsx | real-readonly-react-with-synthetic-history |
| 资源监控 · RSS历史 | /plugins/resource-monitor/history/rss | Code-suphub/flowhub-plugins | plugins/resource-monitor/src/App.tsx | real-readonly-react-with-synthetic-history |
| 资源监控 · 脚本来源 | /plugins/resource-monitor/script-sources | Code-suphub/flowhub-plugins | plugins/resource-monitor/src/App.tsx | real-readonly-react-with-synthetic-history |
| 资源监控 · 卡片完整指标 | /plugins/resource-monitor/card/all-metrics | Code-suphub/flowhub-plugins | plugins/resource-monitor/src/App.tsx | real-readonly-react-with-synthetic-history |
| 资源监控 · 卡片显示设置 | /plugins/resource-monitor/card/settings | Code-suphub/flowhub-plugins | plugins/resource-monitor/src/App.tsx | real-readonly-react-with-synthetic-history |
| 启动器 · 邮件验证码与历史 | /launcher/verification | Code-suphub/flowhub | app/src/search/VerificationPreview.tsx | synthetic-mail-search-adapter |
| 启动器 · 已连接邮箱等待验证码 | /launcher/verification/waiting | Code-suphub/flowhub | app/src/search/VerificationPreview.tsx | synthetic-mail-search-adapter |
| 插件详情 · 独立窗口导航 | /plugin-detail | Code-suphub/flowhub | app/src/surfaces/PluginDetail.tsx | real-shell-with-reusable-public-detail-component |
