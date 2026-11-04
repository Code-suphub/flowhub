# 独立插件运行协议

FlowHub 宿主使用 schema 2 原生进程插件。官方插件在独立仓库 flowhub-plugins 维护，本地检出位于宿主根目录的 plugins/（宿主 Git 忽略该目录），机器插件源码为 plugins/plugins/machines，安装时选择其 build/ 子目录。原同级路径可保留指向新位置的兼容软链接，应用的插件清单及本地来源应使用新的实际路径。各插件独立构建和发布，宿主不再编译机器页面、SSH、堡垒机或机器历史数据库模块。

宿主注册表为数据根目录下的 plugins.json；每个插件的数据位于 数据根目录/插件ID。停用和卸载只移除加载关系，保留数据。

独立胶囊插件栏与展开面板使用普通窗口层级，切换到其他应用时遵循系统窗口前后顺序，不强制置顶。打开或复用窗口时也恢复普通层级；桌面组件的置顶仍由其独立配置控制。

macOS 使用 AppKit 原生父子窗口关系连接设置、胶囊和展开面板。拖动设置时系统同步移动整个窗口组，保持相对位置，允许胶囊随设置移出屏幕；不限制在显示器底部，也不反向移动或缩放设置。只有尺寸、缩放比例和胶囊内容宽度变化时重新定位，关闭时解除绑定，避免已关闭的面板被父窗口重新带出。

确认关闭设置窗口时，同时收起胶囊栏和展开面板；原生销毁设置窗口也执行兜底收起。未保存修改的确认仍由设置页处理，取消关闭或保存失败不会隐藏工作区。随后重新打开设置会显示胶囊栏，插件面板保持收起；菜单栏也可在没有设置窗口时单独打开插件工作区。

迁移已安装的本地插件目录时，先退出宿主并备份数据根目录的 `plugins.json` 与 `plugin-sources.json`，再将插件目录整体移动，更新清单中的 `directory` 和本地来源的 `location`，最后重新启动宿主。使用新目录的真实路径，避免旧软链接与资源越界检查的规范化路径不一致；插件 ID、配置及历史数据保持原位置。

包入口 flowhub-plugin.json 包含 schema、id、name、version、ui、executable、permissions。所有页面和可执行路径必须在包目录内；ui 的资源限制在页面目录。native-process 权限表示本机进程拥有当前用户权限；安装前展示权限确认。

页面通过 flowhub-plugin 自定义协议加载，iframe 使用 allow-scripts 沙箱；插件不能访问父页面或 Tauri 桥。父窗口验证消息来源，并只把请求发给当前选定插件进程。页面无法指定其他插件 ID。宿主的 plugin_api 和 plugin_rpc 只接受 settings 窗口调用。

重新加载重新校验 manifest，并重启进程；页面每次进入使用无缓存资源。前后端均随插件目录更新，不需宿主编译。可执行文件需先构建。

迁移后需安装一次新 FlowHub 宿主。市场主界面提供“发现”和“已安装”两个视图；来源通过“来源设置”对话框管理，本地开发目录安装位于更多操作。首次进入读取已配置来源并自动刷新，最多同时读取三个来源；一个来源失败时保留其他来源的结果，问题在来源设置中展示。搜索在当前已读取的目录中过滤名称、ID、描述及来源，不触发额外网络请求；每次先显示 24 个插件，可继续加载。

发现页使用插件摘要卡片，展示真实清单中的版本及搜索／组件／状态能力。同版本已安装项进入管理，需要重装时在更多菜单明确选择；不同版本显示“更换版本”。安装确认列出来源和版本，存在已安装版本时一并显示。已安装列表显示启用状态，将重新加载和卸载收进更多菜单。安装、更换和卸载仍须明确确认；签名、权限与原生插件隔离边界保持原实现。

发现页支持按真实清单能力与配置来源组合筛选，筛选及搜索仅处理已读取的数据。卡片名称及“查看详情”打开完整介绍、可安装／本机版本、能力、来源与运行权限；浏览详情不会安装，继续安装仍进入独立确认。详情根据当前候选记录取得安装凭据，来源失效后不保留旧凭据。

“连接官方库”使用宿主内置的六个公开版本目录及固定 minisign 公钥（`app/src/market/official.ts`），来源为 [flowhub-plugins 的公开 Releases](https://github.com/Code-suphub/flowhub-plugins/releases)。点击后只添加缺少的来源，再统一刷新所有目录，不安装或升级插件。已配置的同地址、同公钥来源按原配置保留；同地址不同公钥会报告冲突，不能直接覆盖。部分写入失败仍重新读取实际来源并刷新所有安装凭据，重试只补充缺少项。当前目录固定到明确发布版本，刷新不等同于更新；版本和公钥的维护须对照插件仓库的[发布说明](https://github.com/Code-suphub/flowhub-plugins/blob/main/docs/releases.md)。当前这六个版本仅提供 macOS Apple Silicon 包，原生层继续按宿主 target 筛选。

来源保存或移除会作废原生运行时中的全部候选安装凭据，因此界面先移除旧候选，再重新读取所有剩余来源，不保留可点击的旧安装凭据。慢来源的响应不会切走用户当前视图或清空查询。

界面组织参考 [Zed 扩展页面](https://github.com/zed-industries/zed/blob/main/crates/extensions_ui/src/extensions_ui.rs)的集中搜索与安装状态筛选、[Flow Launcher 插件商店](https://github.com/Flow-Launcher/Flow.Launcher/blob/dev/Flow.Launcher/SettingPages/Views/SettingsPanePluginStore.xaml)的插件摘要和安装状态，以及 [Open VSX](https://github.com/eclipse-openvsx/openvsx/blob/main/webui/src/components/extension-list.tsx)的目录筛选和详情入口；由宿主现有 React 公共控件实现，未引入其他插件协议。

原机器目录保留；旧机器 state.json 中的 folders、sources、source 会首次迁移到通用 plugin-sources.json。旧 schema 1 包扫描时明确提示升级，不自动执行。

HTTPS 来源需要 minisign 公钥。索引格式为 schema:2、plugins 数组；每项包含 manifest（与包内清单完全一致）、target（如 macos-aarch64 或 macos-x86_64）、url、sha256、signature。签名针对完整下载包字节，使用与更新器相同的 minisign 验证格式。仅允许 HTTPS，不支持把 Git 仓库 URL 当作安装包；私有仓库需提供客户端可访问的索引及下载地址。

下载包为 JSON：schema:2，files 对象的键是包内相对路径、值为文件内容的 Base64。需包含 flowhub-plugin.json、页面资源和已编译后端。宿主在签名与 SHA-256 校验后解包，拒绝越界路径，校验 manifest 一致性并赋予入口执行权限。索引最多 2 MiB，下载包最多 192 MiB，解包数据最多 128 MiB。安装后独立包保存在 plugin-packages 下，不运行安装脚本。
