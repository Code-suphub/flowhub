# 双屏与全屏唤出验收

开启设置中的“启用采样”，通过全局快捷键唤出。诊断文件位置以设置页显示为准（默认在剪贴板存储目录的 `diagnostics/diagnostics.jsonl`）。查找 `event: launcher-show`。

记录只包含几何、状态和耗时，不包含搜索词。写盘在后台执行；关闭采样不追加记录。

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 普通桌面／浏览器 | 鼠标分别放在两屏，各唤出 5 次 | 在鼠标所在屏幕显示且可直接输入 |
| Warp／GoLand 全屏 | 两屏分别作为全屏与普通屏，交替唤出 | 不跳离当前 Space，在目标屏幕可见且可输入 |
| 混合缩放／上下布局 | 调整排列后分别唤出 | 定位使用逻辑点，未偏移到另一屏 |
| Space 切换 | 切换桌面及全屏 Space 后唤出 | 无残留窗口、无焦点丢失 |
| 插拔显示器 | 拔下外屏后唤出，再接回唤出 | 窗口落在有效屏幕范围内 |
| 返回搜索 | 进入结果按钮后按 Command+K | 聚焦并选中现有查询，输入可替换 |
| 两排快捷入口 | 空查询分别进入全部、应用、网页范围，检查常用及最近两组，包含不同长度、单组为空及共享对象 | 上下跨排保持列，短排暂选末项且回返恢复列；普通结果交界可往返，Enter 打开选中对象，空组不遮蔽另一排 |
| 输入光标与同排导航 | 空输入选中快捷入口按左右键，再分别输入文字、空格，组合输入时切字、回车 | 仅完全空输入且焦点在搜索框时同排移动；文字与空格保留光标移动，组合输入不误选择或打开结果 |
| 结果与预览 | 在长标题／路径／命令及剪贴板之间用方向键、单击切换，悬停其他结果后双击或 Enter | 860×600 窗口中左侧摘要不展开，右侧显示选中项详情；悬停不改选中项；单击不执行，双击或 Enter 只执行一次且目标与预览一致 |
| 预览与操作焦点 | 按 ⌘I、F6、⇧F6、Tab、Escape，再在窄于 720 的预览窗口重复 | ⌘I 聚焦详情，Escape 返回搜索；F6 循环复制、主操作和更多菜单；详情内 Tab 不切范围；窄窗口单击进入详情，返回按钮或 Escape 回到列表，输入新查询显示列表 |
| 只读演示 | 浏览器打开 `?preview=demo`，切范围与快捷入口，查看详情 | 显示本地演示数据和只读演示标识；复制、粘贴、修改禁用，不写配置、不调用原生动作 |

关键字段：`pointerScreenIndex` 与 `screens` 对应鼠标屏幕；`target` 为实际选用屏幕；`selection=fallback` 表示未命中鼠标屏幕而回退。`before`／`after` 为窗口位置，坐标均为 AppKit 逻辑点。

`mainThreadQueueMs` 测主线程任务排队，`nativeShowMs` 测从排队到原生显示调用结束（包含排队）。两者不包含快捷键分发前的等待，也不代表 WebKit 首帧或肉眼可见延迟。`visible`／`keyWindow` 只描述调用后原生状态，不能单独证明全屏 Space 中实际可见。

遇到异常时记录场景、目标屏幕、实际屏幕和对应事件时间。几何单元测试通过不替代上表的真实显示器验收。

## 输入焦点与窗口生命周期

唤出需要按顺序完成四个步骤：进程取得系统键盘焦点、NSPanel 显示并成为 key window、实际 WKWebView 成为原生 first responder、搜索页恢复适当的 DOM 焦点。`macos/launcher_activation.rs` 在主线程通过 NSRunningApplication 显式激活进程；收到原生激活通知并确认当前前台属于自身后，才显示已定位的面板并请求 key window，避免先出现可输入界面却仍向原应用发送按键。否则激活过程也可能稍后选中桌面组件等普通窗口，覆盖过早的面板聚焦。`macos/launcher_focus.rs` 随后恢复实际 WKWebView，不能把包含 WebView 的 `contentView` 容器当作输入接收者。恢复仅在当前显示会话仍有效、窗口仍可见且为 key window 时执行。隐藏、启动外部应用或再次唤出都会作废旧会话，迟到的显示或聚焦回调不能抢回键盘。原生激活通知的重入由进程内守卫隔离。

Workspace 通知使用自身携带的应用对象判断激活方，不把激活过程中暂未更新的 frontmost 状态当作外部切换。迟到的外部通知在自身已处于前台、或尚在从原应用激活期间不收起新会话；真实切到另一应用仍优先。已开始启动／粘贴的隐藏会话也不能被外部通知再次 dismiss，避免误作废启动恢复票据或提前清理粘贴接收者。

前端控制器在首帧布局阶段绑定交互，输入不等待插件、配置或索引查询完成。窗口重新获得焦点时只补齐缺失焦点，不重新选中已输入文字，不抢走菜单、操作按钮、其他编辑控件或输入法组合输入。初始化完成也遵守同一规则。快捷键显式返回搜索框时仍可选中现有查询。

切到其他应用可能在编辑剪贴板副本或确认删除时隐藏窗口。再次唤出保留原查询、草稿和确认状态，不用空查询替换其结果列表；恢复到编辑框或对话框后由用户继续、保存或取消。

设计参考：[EcoPaste macOS 窗口生命周期](https://github.com/EcoPasteHub/EcoPaste/blob/master/src-tauri/src/window/macos.rs)、[Sol PanelManager](https://github.com/ospfranco/sol/blob/main/macos/sol-macOS/managers/PanelManager.swift)。FlowHub 保留自己的 Tauri 宿主、插件协议及存储，不引入这两个应用的运行时。

### 非激活面板的系统状态

原生 key window、WebView first responder 和 DOM focus 均为 true，仍不能单独证明全局键盘已路由到启动器。`tauri-nspanel::to_panel` 通过转换现有 NSWindow 的类实现 NSPanel，未执行 NSPanel 初始化；仅追加 `NonactivatingPanel` 样式还可能遗漏 WindowServer 的禁止激活状态。FlowHub 将窗口库固定到包含[上游修复 #139](https://github.com/ahkohd/tauri-nspanel/pull/139)的 `854634cc4b4a6a01caef464d2de83efae42403a2`，由库在设置样式后同步系统状态，并检查私有 selector 的可用性。显式激活方案清除 `NonactivatingPanel` 位，保留 Tauri 原有结构样式，避免混用非激活面板的键盘借用和进程激活两套交接。原生拒绝设置时返回初始化错误。

| 参考实现 | 原生处理 | FlowHub 的取舍 |
| --- | --- | --- |
| EcoPaste `window/macos.rs` | 非激活 NSPanel；主线程显示／隐藏；显示前等待 16 ms；固定窗口粘贴时先放弃 key，再恢复 | 参考面板配置和主线程生命周期；保留自己的显示会话保护和显式进程焦点交接 |
| Sol `views/Panel.swift`、`managers/PanelManager.swift` | 创建时即指定 NSPanel 的非激活样式；选择目标屏幕后 `makeKeyAndOrderFront`；原生 delegate 异步处理失焦 | 参考原生初始化状态和屏幕选择顺序；保留自己的 WKWebView responder 与 DOM 焦点恢复 |
| tauri-nspanel #139 | 转换普通窗口后补齐系统禁止激活标记；支持启用和移除样式；保留结构样式并捕获原生异常 | 采用上游实现并锁定提交；清除非激活位时同步系统标记，避免在宿主重复维护私有 API |
| [Maccy FloatingPanel](https://github.com/p0deje/Maccy/blob/master/Maccy/FloatingPanel.swift)、[Clipboard](https://github.com/p0deje/Maccy/blob/master/Maccy/Clipboard.swift) | 原生非激活面板与粘贴流程分离；剪贴板写入和合成粘贴独立处理 | 参考生命周期分离；FlowHub 自行实现显式激活后的接收应用记录与校验，没有照搬 Maccy 的显示策略 |

上游 #139 的实机记录来自 macOS 27，明确未测 macOS 15。该缺口与本项目的窗口创建路径吻合，但是否修复本机间歇性输入问题必须重新验收，不能把上游实验当成本机结论。至少覆盖普通模式冷启动、打开／关闭设置及插件工作区后的再次唤出、两屏各连续 5 轮；用专用接收文稿核对是否有字符落入原应用。禁止用应用定向输入代替全局键盘路由检查。

自动化循环必须分别确认收起和显示状态，不能连续无间隔发送两次唤出快捷键后盲目输入。现有 250 ms 冷却会有意过滤第二次触发，此时字符进入原应用属于“未再次显示”，不能直接当作“显示后失焦”。同样，确认窗口未显示时应停止该轮，避免后续循环的显隐相位错位。

显式 `--focus-diagnostics --focus-diagnostics-no-loop` 会补充显示前后的进程内 key window、应用激活状态和前台是否属于自身等布尔值，以及按键是否到达 AppKit 的结构事件。窗口仅用本进程的 window number 区分；不读取按键文字、键码、修饰键、窗口标题或其他应用标识。未开启诊断时不安装原生监听，不增加输入采样。诊断成功仍需普通模式复测。

### 收起与原应用的交接

显式激活会改变前台应用，因此唤出时在内存中保留原 NSRunningApplication 实例。固定窗口保持显示时，真实的外部激活更新内存接收者及代次，避免点击固定窗口后使用更早的返回目标；尚在激活中的迟到通知不覆盖目标。收起只隐藏启动器面板，桌面组件仍保留；仅当前台仍为 FlowHub 时才返回原应用，用户主动切到另一应用优先。进入设置会清理本次返回目标并交给设置自身取得焦点，不先激活外部应用；启动外部入口前先收起并交回原应用，失败恢复保留原查询及返回目标。

自动粘贴在读取记录前捕获显示会话及接收者代次；原会话已结束、被新唤出替换、或固定窗口的接收应用在读取期间改变时，只完成复制，不关闭新窗口或继续发送按键。原生对象只留在主线程，后台命令读取原子代次，不同步查询应用或窗口。收起后恢复原应用，原实例未退出、原应用确已处于前台、返回目标代次未变化且没有新的唤出时才发送粘贴。校验失败保留剪贴板内容并返回手动粘贴提示，不向未确认的应用发送按键。正常收起、固定窗口点击取回焦点、从设置返回，以及全屏／Space／多屏必须分别实测，不能从编译或原生布尔值推定通过。

可使用独立 AppKit/WKWebView 冒烟脚本验证原生 responder 链和生产搜索页。它只加载本机只读演示页，键盘事件仅发送到脚本自己的进程，不打开 FlowHub 用户数据：

```sh
cd app
pnpm run build:ui
pnpm exec vite --config vite.config.mjs --port 5199
# 在另一个终端，使用上面的只读预览服务：
swift scripts/native/launcher-input-smoke.swift --url 'http://127.0.0.1:5199/search.html?preview=demo'
# 对照组：只聚焦容器，应捕获键盘落到容器而搜索框未收到文字：
swift scripts/native/launcher-input-smoke.swift --legacy --url 'http://127.0.0.1:5199/search.html?preview=demo'
```

默认脚本连续执行 20 轮显隐、原生焦点切换与输入。它验证同一测试进程内的真实 WKWebView 输入，不替代上表跨应用、输入法、多屏及全屏 Space 的实际应用验收。
