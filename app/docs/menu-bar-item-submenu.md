# 逐个图标控制：原生附属子菜单

## 交互目标

- 菜单层级为 FlowHub → 菜单栏整理 → 逐个图标控制；最后一级直接在父菜单旁展开，由 macOS 决定方向和屏幕边缘适配。
- 菜单入口不再打开独立置顶 WebView。保留已有面板命令作为其他入口的兼容路径，不删除设置页管理能力。
- 子菜单用 NSMenuItem 自定义视图承载图标名称、状态和右侧开关，避免普通菜单项选择后主动结束整个菜单会话。
- 打开时读取图标清单；批量操作中保持顺序和行高，只更新状态，不按显示／隐藏重排。
- 单项操作异步执行；操作中禁用重复提交；失败展示错误并以实际状态为准，不能把控件点击当作显隐成功。
- 子菜单打开期间延后父菜单重建，关闭后刷新；旧菜单异步结果不能更新新的菜单会话。

## 范围

本次是菜单呈现方式修改，不是底层模拟输入替代。无光标干扰、无闪现仍需单独验证，不能因为改成子菜单就声称已解决。

## 验证

### 区内顺序记忆

按用户要求先提交当前版本为 `261826a`，顺序恢复作为后续独立修改。隐藏前记录同分区的左到右身份顺序；恢复时优先使用仍在该分区的最近右邻居（插到其左侧），否则最近左邻居（插到其右侧）。连续隐藏多项时保留已隐藏项的顺序占位，支持不同顺序恢复。身份歧义、邻居离开该分区或已退出时跳过；没有有效邻居则退回分区默认位置，不跨分区追随邻居。以前版本只有分区记录、没有顺序记录的图标不能追溯原顺序，须从新版的一次隐藏开始记录。

记忆文件新增可选 orders/section_orders，兼容旧版记录读取。新增测试覆盖中间图标恢复、邻居缺失/改分区、批量隐藏后不同顺序恢复、旧格式迁移；29 项 Rust 测试通过。诊断 restore_plan 增加 orderAnchorFound 区分顺序恢复与分区回退。

首次实测发现旧移动算法将“位于目标任意左侧”当作完成，导致始终隐藏中的图标被错误提前返回成功。已为顺序目标添加 require_adjacent，移动前、动画等待和最终验证均要求与锚点边缘相邻（允许少量像素误差），分界目标继续保留原分区判断。新增防止离屏误判的测试，完整测试增至 30 项。

最终安装 `0.1.5-local.20260906155701`，签名验证通过。本轮开始前版本保存在 `/tmp/flowhub-order-backup.260h5X/FlowHub.app`。实测 Token Monitor 从跟随分区隐藏后，跨应用重启，利用 orderAnchorFound=true/targetWindowId=2660（CleanShot X）恢复；AX 显示跟随分区。即时 direct_move 快照中其他图标尚在动画中，存在窗口重叠，不能用该帧的全局 x 排序判定最终顺序；关闭再打开后重新枚举清单，顺序为 CleanShot X → Token Monitor → Clash Party，与隐藏前一致，其余清单顺序也一致。测试图标已恢复，不再留在始终隐藏区。本轮顺序修改尚未提交。

### 分区记忆与固定菜单入口

基线（包括已验证的持久开关与布局修正）已按用户要求提交为 `eeb3676`。后续改动独立保留。

为消除悬浮时原生菜单→浮层的坐标跳变，主状态按钮从第一次点击起就使用同一套浮层。子菜单的 hover 只 orderFront/orderOut 已定位的子窗口，不重建或移动祖先。保留源 NSMenu 及其动作目标用于设置、展开/收起和退出等菜单动作；仅对主状态按钮隐藏 tray-icon 的输入覆盖视图，保留其生命周期/尺寸管理。再次点击主图标关闭整组菜单。`menu_bar_overlay_reveal` 的 ancestorFramesUnchanged 用于检查展开过程中祖先坐标保持不变。

逐项关闭前记录原来的 hidden/visible 分区；重新开启时恢复分区而不是一律放到箭头右侧。开关说明改为“开：恢复原分区”。历史未知或身份冲突的旧图标沿用常显回退，并记录回退原因；不推测历史顺序。此功能记忆分区，不承诺恢复区内精确排序。

记忆文件为应用数据目录下 `menu-bar-sections.json`（独立于设置草稿），使用原子写入。唯一的 owner/stableId 支持无标题的第三方图标，出现身份冲突则持久标记歧义，不将一项的记忆误套给另一项。新增 8 项测试覆盖重启恢复、左右目标、失败重试、无标题唯一项与冲突，完整测试共 26 项通过。

Computer Use 已从主按钮动作入口依次操作“菜单栏整理 → 逐个图标控制”（不是直接打开末级面板），15:41:10 与 15:41:19 的 reveal 日志均为 ancestorFramesUnchanged=true。TextInputMenuAgent 实测 hidden → alwaysHidden → hidden；第二次规划 destination=hidden/fallbackReason=null，实际移动 ok=true，AX 恢复“跟随分区”，浮层保持打开。记忆文件确认该无标题图标记录为 hidden。Esc 已验证关闭，关闭后重新打开菜单成功。整体收起/展开动作均成功，测试后恢复 collapsed=false；发现并补上每次打开时刷新分区动作标题，避免旧菜单源保留过时文字。恢复分区的实测验证不包含区内精确顺序。

最终安装版 `0.1.5-local.20260906154404` 签名验证通过；上一迭代包备份 `/tmp/flowhub-final-backup.7b6Tjm/FlowHub.app`，本轮开始前的版本在 `/tmp/flowhub-memory-backup.XgF8XN/FlowHub.app`。最终包中 CUA 确认版本，执行收起后重新打开，按钮正确显示“展开隐藏区”，随后恢复展开。设置草稿未保存/重置。新增两项修复未包含在基线提交 eeb3676 中，保留工作区供后续提交。

### 持久附属浮层

#### 正常入口接管修正

#### 接管后的行堆叠回归

用户截图显示所有行叠在文档底部，并非文字编码异常。移交时只 removeFromSuperview 仍让 NSMenuItem 持有原 view，原生跟踪退出期间可继续重排；现先通过 setView(None) 解除各图标行与菜单项的关联，再以固定 34pt 行高独立布局。原生 header/delegate 保留在原菜单中，浮层另建说明行，避免破坏再次打开的 delegate 生命周期。父菜单宽度沿用 NSMenu.size，子层沿入口行错开。新增延迟 300ms 的 menu_bar_overlay_layout 日志，检查实际坐标 rowsSeparated；此检查不等于截图视觉验收或连续显隐验收。

修正版 `0.1.5-local.20260906152453` 已安装，旧包备份 `/tmp/flowhub-layout-backup.gA8gnB/FlowHub.app`；18 项测试和签名检查通过。通过诊断入口打开同一浮层后，Computer Use 截图确认 13 行正常分开，延迟日志 rowsSeparated=true，y 从 414 至 6 以 34pt 递减。实际点击电池开关显示成功（visibility_changed hidden=false/ok=true），AX 仍停留在逐个图标控制；随后再次点击恢复始终隐藏，AX 开关恢复 0，菜单仍打开。日志确认自投递事件被关闭观察器忽略。尝试 Esc 时 CUA 提示用户已切换应用，未继续发送输入，Esc 未验收。正常悬浮入口的全菜单位置切换仍待用户核对，不能将诊断入口截图视为位置不跳动的证据。

15:12:32 的用户操作只有 `submenu_opened`，未出现 `overlay_opened`，随后模拟事件再次关闭了原生菜单。原先通过 `viewDidMoveToWindow` 调度不能覆盖视图复用/回调时序。改为在 `menuWillOpen` 设置 tracking 后调度接管；开关操作前再次检查浮层，未成功打开就恢复开关并记录 `menu_bar_overlay_handoff_failed`，不投递模拟事件。新增 `--menu-bar-menu` 只触发真实 status button 菜单，用于验证正常三级菜单入口，区别于直接打开浮层的 `--menu-bar-controls`。

修正版 `0.1.5-local.20260906151716` 已构建并安装，18 项测试、JS 语法检查、签名验证及 diff 检查通过。旧版备份 `/tmp/flowhub-entry-backup.KfzYVR/FlowHub.app`。Computer Use 在设置页确认新版本及草稿保留，但状态菜单未出现在其 AX/截图中；`--menu-bar-menu` 调用后也未取得三级菜单打开证据。已请求用户从真实入口打开并保持，等待核对 `submenu_opened → overlay_opened` 和后续连续显隐日志，尚不宣称交互验收通过。

14:51:16 的复现日志中：toggle_requested → 202ms 后 LeftMouseDown 投递 → 50ms 后 submenu_closed → LeftMouseUp。旧版自定义 NSMenuItem 仍处于系统菜单跟踪中，未解决模拟输入引发关闭。

新实现进入逐项控制时一次性将三级菜单转交给无标题、非激活的 NSPanel 级联；保留父级菜单动作和即时显隐，不用操作后重开菜单或关闭后批量应用来掩盖。应用图标、紧凑行、原顺序和行内进度沿用。浮层按当前状态项位置定位，多屏使用所在屏幕坐标，长列表滚动。

移动事件携带 `0x46485542` 前缀及目标窗口 ID。浮层关闭观察器只忽略此前缀且来源 PID 为本进程的事件，不消耗真实鼠标输入。真实外部点击、Esc、切换应用及叶子菜单动作会关闭；切换开关不主动关闭。菜单刷新延至整个浮层关闭。

日志新增 `menu_bar_overlay_opened`、`menu_bar_overlay_ignored_synthetic`、`menu_bar_overlay_closed`（reason）。运行中应用可通过 `FlowHub.app/Contents/MacOS/flowhub-tauri --menu-bar-controls` 打开同一实现，方便自动化读取；正常入口仍是菜单栏的三级菜单。18 项 Rust 测试及 JS 语法检查通过，真实 UI 验证结果另记。事件观察器使用 AppKit [本地/全局事件监测](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/MonitoringEvents/MonitoringEvents.html)，并在会话关闭时移除。

候选版 `0.1.5-local.20260906150411` 已安装到 `/Applications/FlowHub.app`，签名验证通过；原版本保留在 `/tmp/flowhub-cascade-backup.1fROJJ/FlowHub.app`。15:07:06 日志记录浮层成功创建（3 panels、13 rows），进程存活。Computer Use 返回 Mac 已锁定且无法自动解锁，因此没有截图、没有实际切换图标，三级菜单的原生入口切换和连续显隐均未完成 UI 验证；需用户解锁后继续，不能标记为交互验收通过。

### 紧凑布局与关闭时序排查

用户反馈首版行高过大、缺少图标，且切换后菜单关闭。当前将宽度收紧至 304pt、行高降至 34pt，加入应用图标、12pt 名称、10pt 次要状态及小号开关。处理进度仍在原行显示，不增加顶部占位，不改变列表顺序。

自定义行消费自身鼠标事件，不主动结束菜单跟踪；这不保证后续系统级模拟输入不会关闭菜单。新增 `menu_bar_submenu_opened`、`menu_bar_submenu_toggle_requested`、`menu_bar_submenu_closed` 和 `menu_bar_item_event_post`，用来区分开关响应与外部事件投递导致的关闭。关闭问题在实际复现前仍视为未解决；未通过自动重开或关闭后延迟应用来掩盖。

本轮 `cargo check --locked` 与 `npm test`（16 项 Rust 测试及 JS 语法检查）通过，真实菜单连续切换仍待复验。

紧凑版 `0.1.5-local.20260906144848` 已构建并安装，签名验证通过，Computer Use 从设置页确认版本与草稿保留。安装前的应用移至 `/tmp/flowhub-compact-backup.Kf07qA/FlowHub.app`，可恢复。自动化未读取到状态栏菜单，需要用户实际切换一次以采集新增关闭时序日志；当前不能宣称已解决自动关闭。

2026-09-06：`npm test` 的 16 项 Rust 测试和 JS 语法检查通过；额外 `node --check ui/menu-bar-panel.js`、`git diff --check` 通过。构建生成 `0.1.5-local.20260906143659`，本地开发证书签名和 `codesign --verify --deep --strict` 通过。

旧版本备份在 `/tmp/flowhub-submenu-backup.DZn5Lh/FlowHub.app`（另保留移动出的 `FlowHub-original.app`），新包已安装到 `/Applications/FlowHub.app` 并启动。Computer Use 在设置页读取到新版本号，启动日志确认主菜单创建成功、隐藏分区 enabled=true/collapsed=false。原设置草稿保留，未保存或重置草稿。

菜单栏状态项未在自动化 AX 中暴露；已请求用户手动展开三级菜单供后续观察。尚未验证菜单打开时的实际开关操作，也没有点击任何真实图标显隐开关。重点仍需检查三级展开、右侧开关、菜单关闭行为、连续操作顺序、失败状态和重新打开时刷新。不得以编译通过代替这些交互结论。
