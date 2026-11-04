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

唤出需要按顺序完成三个步骤：NSPanel 成为 key window、实际 WKWebView 成为原生 first responder、搜索页恢复适当的 DOM 焦点。`tauri-nspanel` 的 `show_and_make_key` 把 `contentView` 交给 `makeFirstResponder`；它可能只是包含 WebView 的容器，因此不能用窗口可见或 DOM 的 `activeElement` 单独判断键盘输入已就绪。`macos/launcher_focus.rs` 在 Tauri 的主线程 WebView 回调中恢复实际视图，仅在当前显示会话仍有效、窗口仍可见且为 key window 时执行。隐藏、启动外部应用或再次唤出都会作废旧会话，迟到的显示或聚焦回调不能抢回键盘。

前端控制器在首帧布局阶段绑定交互，输入不等待插件、配置或索引查询完成。窗口重新获得焦点时只补齐缺失焦点，不重新选中已输入文字，不抢走菜单、操作按钮、其他编辑控件或输入法组合输入。初始化完成也遵守同一规则。快捷键显式返回搜索框时仍可选中现有查询。

切到其他应用可能在编辑剪贴板副本或确认删除时隐藏窗口。再次唤出保留原查询、草稿和确认状态，不用空查询替换其结果列表；恢复到编辑框或对话框后由用户继续、保存或取消。

设计参考：[EcoPaste macOS 窗口生命周期](https://github.com/EcoPasteHub/EcoPaste/blob/master/src-tauri/src/window/macos.rs)、[Sol PanelManager](https://github.com/ospfranco/sol/blob/main/macos/sol-macOS/managers/PanelManager.swift)。FlowHub 保留自己的 Tauri 宿主、插件协议及存储，不引入这两个应用的运行时。

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
