# 独立插件运行协议

FlowHub 宿主使用 schema 2 原生进程插件。机器业务已迁至同级独立仓库 flowhub-machines-plugin，宿主不再编译机器页面、SSH、堡垒机或机器历史数据库模块。

宿主注册表为数据根目录下的 plugins.json；每个插件的数据位于 数据根目录/插件ID。停用和卸载只移除加载关系，保留数据。

包入口 flowhub-plugin.json 包含 schema、id、name、version、ui、executable、permissions。所有页面和可执行路径必须在包目录内；ui 的资源限制在页面目录。native-process 权限表示本机进程拥有当前用户权限；安装前展示权限确认。

页面通过 flowhub-plugin 自定义协议加载，iframe 使用 allow-scripts 沙箱；插件不能访问父页面或 Tauri 桥。父窗口验证消息来源，并只把请求发给当前选定插件进程。页面无法指定其他插件 ID。宿主的 plugin_api 和 plugin_rpc 只接受 settings 窗口调用。

重新加载重新校验 manifest，并重启进程；页面每次进入使用无缓存资源。前后端均随插件目录更新，不需宿主编译。可执行文件需先构建。

迁移后需安装一次新 FlowHub 宿主。市场提供发现、已安装、来源三个页面；先添加本地目录或 HTTPS 仓库，再扫描和安装。开发目录安装仍作为快捷方式保留。原机器目录保留；旧机器 state.json 中的 folders、sources、source 会首次迁移到通用 plugin-sources.json。旧 schema 1 包扫描时明确提示升级，不自动执行。

HTTPS 来源需要 minisign 公钥。索引格式为 schema:2、plugins 数组；每项包含 manifest（与包内清单完全一致）、target（如 macos-aarch64 或 macos-x86_64）、url、sha256、signature。签名针对完整下载包字节，使用与更新器相同的 minisign 验证格式。仅允许 HTTPS，不支持把 Git 仓库 URL 当作安装包；私有仓库需提供客户端可访问的索引及下载地址。

下载包为 JSON：schema:2，files 对象的键是包内相对路径、值为文件内容的 Base64。需包含 flowhub-plugin.json、页面资源和已编译后端。宿主在签名与 SHA-256 校验后解包，拒绝越界路径，校验 manifest 一致性并赋予入口执行权限。索引最多 2 MiB，下载包最多 192 MiB，解包数据最多 128 MiB。安装后独立包保存在 plugin-packages 下，不运行安装脚本。
