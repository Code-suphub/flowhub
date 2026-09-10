# 插件状态组件

插件 manifest 声明 `statusSurface: true` 后，可提供只读 `status_snapshot` RPC。宿主每 15 秒读取摘要，不提交采集或远程命令。摘要格式为 `{title, monitoring, rows:[{id,name,status,at,values:{cpu,memory,disk}}]}`；status 为 healthy/error/stale/unknown，at 为采集时间毫秒值。不得包含密码、私钥、SSH 参数或原始命令输出。

FlowHub 提供独立菜单栏状态下拉与可拖动、置顶的桌面监控窗。窗口的显示配置由宿主 `plugin-status.json` 保存，关注项按机器 ID 筛选，未选则显示全部；插件停用或卸载后移除窗口和菜单栏入口。菜单栏最多显示 12 项，其余在监控窗查看。关闭窗口后可从机器页「桌面与菜单栏」重开。正在显示的窗口可随 FlowHub 下次启动恢复；位置在关闭时保存，已移除显示器上的位置会回到主屏。

机器插件按采集间隔的三倍判断数据过期；没有数据为未采集，采集失败为异常，不将这两种情况称为离线。重启后的内存采集缓存为空时显示未采集。

## 原生 WidgetKit 扩展

当前实现是独立桌面监控窗口，不是 macOS 小组件图库中的 WidgetKit 扩展。当前环境只有 Command Line Tools，没有完整 Xcode、Widget 扩展 target 和用于 App Group 的团队签名配置。原生小组件需要单独的 Swift/WidgetKit 扩展、App Group 共享摘要文件、签名与宿主打包流程，并受系统刷新预算限制；不能通过 Tauri 页面模拟注册进小组件图库。后续扩展应复用这里的无凭据状态摘要，不直接访问插件密码数据库。
