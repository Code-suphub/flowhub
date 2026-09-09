# 重启后首次交互排查

## 已确认的问题及修复

- `search_clipboard` 原为同步 Tauri command；数据库打开、存储锁等待与SQL查询直接在IPC同步处理路径执行。`get_config`同样同步读取配置和水合目录。改为异步command内`spawn_blocking`，在后台获取存储租约并查询，不改变SQL和数据契约。冷磁盘或数据库争用可能放大原有阻塞，但尚未量化用户设备的冷查询时间。
- 剪贴板首批查询和图片/文件图标异步返回时，调用不保留滚动位置的render；用户在等待期间滚动会被重置到顶部。现在后台数据/资源补全保持当前位置，查询输入/范围切换仍在交互开始时重置。

## 验证

- app npm test：91项Rust、全部UI、4项预览与生产CSP测试通过。另执行新增延迟查询/延迟图标/过期响应回归：滚动位置不被覆盖，过期图标不污染新结果。
- Chrome隔离页面使用生产search.js和30条合成记录，首次图片异步完成前后scrollTop均为250，30行正常渲染，无JS异常；未访问真实剪贴板/数据库。Chrome trace用于辅助检查，不能作为macOS原生首次交互性能结论。
- 未安装更新，当前已安装应用不会因源代码修改自动生效。未重启实际用户应用采集冷启动WKWebView/原生线程跟踪，不能断言已排除全部卡顿来源。

## 首次点击仍无效的后续修正

重装后用户反馈首次点击剪贴板仍无效，第二次生效。进一步核对本地依赖：主窗口为nonactivating NSPanel，但Tauri窗口acceptFirstMouse未设置，默认false；wry的WKWebView子类直接在acceptsFirstMouse:返回这个值。这是首次点击可能只获取焦点而未传递至页面的原生配置缺口，不等同于查询缓慢。

仅为main窗口设置acceptFirstMouse=true，保持原有全屏Space与不激活Panel行为。重新构建安装验证配置可通过Tauri编译；该配置对主弹窗所有网页控件生效。需要用户在原有首次唤出场景确认实体鼠标单击，不以DOM模拟点击冒充原生事件验收。

## 首次点击丢失输入焦点的后续排查

用户确认acceptFirstMouse补丁后仍复现，且首次点击后输入框失焦、不恢复，后续点击先失焦再恢复。前一配置缺口不足以解释/解决实际问题。

范围按钮原本依赖mousedown默认失焦、click末尾q.focus()恢复；现为范围/类型控件的主鼠标按下阻止默认焦点转移，仍使用click进行切换，保留键盘与右键默认行为。另外renderPluginScopes使用按ID更新的稳定节点，不再无条件删除重建，避免配置刷新打断按下至松开的事件目标；更新时保持当前选中范围，删除当前范围才回到全部。

验证：全套test:ui通过；新增保留输入焦点默认行为、稳定按钮引用、名称更新、禁用范围回退测试。CUA隔离浏览器首次点击剪贴板后显示类型筛选，AX焦点仍为q。真实FlowHub CUA连接超时，未声称原生首次鼠标点击已验收。重新本地构建安装用于原有用户场景验证。

## 真实事件诊断（前述修正后仍复现）

增加显式`--focus-diagnostics`运行参数，仅在当前进程启用。每次最多保存300条结构事件至系统临时目录`flowhub-focus-<pid>.json`；前端最多250条。采集mousedown/mouseup/click、焦点进出、当前scope、activeElement类别与原生窗口焦点/可见性。原生show记录Panel的keyWindow状态。后端对前端字符串采用白名单，不保存输入值、剪贴板正文、URL或错误消息。写盘在线程池完成，不在窗口事件中同步写磁盘。正常无参数启动不保存日志。

已安装0.1.8-local.20260909015007，并显式重启诊断进程。等待用户按原场景首次唤出、点击剪贴板两次后读取事件链；不预先认定故障已修复。诊断启动时已观察到隐藏页面DOM activeElement=q、document.hasFocus=false，这是启动状态记录，并非点击故障结论。

## 已捕获的真实首次点击事件

诊断进程65892，用户手动首次唤出后的记录：

| 前端序号 | 事件 | 目标 | 当前范围 |
| --- | --- | --- | --- |
| 8 | mouseup | scope:clipboard | all |
| 9 | mousedown | scope:clipboard | all |
| 10（第二次点击） | mousedown | scope:clipboard | all |
| 11 | mouseup | scope:clipboard | all |
| 12 | click | scope:clipboard | all |
| 13 | after-click | scope:clipboard | clipboard |

序号由前端同步生成，首次up/down间隔约1ms；两次点击时documentFocused、nativeFocused均true，activeElement为q。首次没有click；第二次正常产生click并切换。因此此轮并非输入框缺焦点，而是原生WebKit传递的首次事件顺序使click未合成。更底层事件为何反序尚未确定，不能声称已经修复WebKit本身。

改动：范围/类型导航在主鼠标mousedown时激活，保持输入焦点；click保留键盘/辅助操作入口，对已选范围去重。此为可逆导航控件，按下即可切换；没有对粘贴、删除等操作采用该语义。使用实际up→down无click序列回放，并检查正常down/click只切换一次、键盘click、右键不切换。全UI测试通过，重新构建安装，保留显式诊断模式供原生回验。
