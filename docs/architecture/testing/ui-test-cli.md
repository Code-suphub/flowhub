# WKWebView 页面验收 CLI

`app/scripts/dev/flowhub-ui-test.mjs` 用于验证实际 macOS WKWebView 内的宿主与插件页面。页面按钮可以通过 CLI 操作，不必移动系统鼠标。系统焦点、真实输入法、全局快捷键、多屏与原生系统弹窗仍需单独验收。

## 入口与隔离

```sh
cd app
pnpm run build:ui-test
pnpm run cli:ui help
```

构建增加可选 Cargo feature `ui-test` 和独立二进制 `flowhub-ui-test`；普通宿主不注册驱动。此二进制从单独入口启动实际插件 Runtime、生产插件工作区、生产 iframe 桥接和生产静态资源，不进入正常启动器初始化：无全局快捷键、剪贴板采集、开机启动、托盘或原实例转发。测试 WebView 使用独立 identifier 和临时会话。

驱动固定依赖 `tauri-plugin-wdio-webdriver` 1.5.1，HTTP 服务只监听回环地址。CLI 验证实例 token，停止时同时核对运行程序 PID。此能力只用于本机专用测试构建，不应加入正常安装版或发布流程。

`start --data` 必须指向明确可丢弃的夹具目录；拒绝主目录和正式 FlowHub 数据目录，首次启动以排他创建的实例标记防止两个测试共用目录。可通过 `--package` 导入可信的本地插件构建，通过 `--module plugin:machines` 进入插件。导入仍使用宿主包校验；这是准备夹具，不算插件市场安装点击通过。

机器管理另要求预先准备 `machines/state.json`、关闭监控、共享配置文件位于测试目录内，连接只允许 `127.0.0.1` 密钥目标。不能直接复制用户真实 SSH 配置来运行验收。服务端校验与 CLI 的正式目录拒绝相互独立。

## 操作示例

已有隔离夹具后启动，保存返回的 `session` 文件路径；每次操作均显式指定它：

```sh
pnpm run cli:ui start --data /private/tmp/my-fixture --package /path/to/machines/build --module plugin:machines
pnpm run cli:ui inspect --session /private/tmp/my-fixture/ui-test-session.json
pnpm run cli:ui inspect --session /private/tmp/my-fixture/ui-test-session.json --frame 0
pnpm run cli:ui click --session /private/tmp/my-fixture/ui-test-session.json --frame 0 --role button --name 断开
pnpm run cli:ui click --session /private/tmp/my-fixture/ui-test-session.json --frame 0 --role button --name 确认断开
pnpm run cli:ui wait --session /private/tmp/my-fixture/ui-test-session.json --frame 0 --css .command-react__connection-status --text 自动连接已暂停
pnpm run cli:ui screenshot --session /private/tmp/my-fixture/ui-test-session.json --output /private/tmp/after-disconnect.png
pnpm run cli:ui stop --session /private/tmp/my-fixture/ui-test-session.json
```

这些路径为示例，不会自动创建 SSH 服务。`--frame 0.1` 表示逐层进入第一个 iframe 内的第二个 iframe。选择目标支持 `--ref`、`--css`，或 `--role` 与精确的 `--name`；多个匹配会失败，不能默认点击第一个。

`fill --value` 通过原生 value setter 和 input/change 事件驱动受控输入；`key --key Enter` 等只验证页面键盘事件处理，不等于硬件输入或真实输入法。`wait --enabled true` 可以等待异步任务后按钮可用；等待文本和操作请求均有截止时间。成功派发点击不等于业务成功，场景仍需等待 UI 结果并核对实际后端或外部状态。

所有结果与错误为 JSON。检查结果包含控件角色、名称、引用、禁用与焦点状态、iframe 的 src/sandbox、弹窗和告警；不批量读取输入值。`read` 显式读取所选内容，拒绝读取密码字段。截图与报告由调用者保存在 Git 外，实例文件按用户私有权限创建。

`run --plan <JSON文件> --output <新目录>` 可重复执行最多 100 步的验收计划。计划是操作对象数组，例如 `[{"op":"click","frames":[0],"target":{"role":"button","name":"断开"}},{"op":"wait","frames":[0],"target":{"role":"button","name":"确认断开"},"enabled":true}]`。支持 inspect/read/click/fill/key/wait/screenshot，不接受执行任意 JavaScript 的步骤。每一步后保存控件快照，失败立即停止，保存 JSON 报告与截图并返回非零退出码；不自动重放点击或提交。

等待异步保存时应等待 `dialog[open]` 消失（`wait --absent true`），而非等待按钮“保存”消失：它可能只是暂时变成“保存中…”。界面编辑器也可能先保留上次字段、随后异步读取新值；必须同时等到保存可用和准确目标字段加载后再填表。

测试目录的 `ui-test-rpc.jsonl` 记录生产处理函数调用前后、请求编号、阶段、耗时与成败，不记录参数、账号、输入或输出正文。只有 start 而无 finish 时，可进一步检查该调用；窗口读取超时本身不能证明业务失败。测试窗口不接受原生键盘焦点，因此此实例刻意不用于系统输入焦点验收。

## 插件隔离与覆盖边界

插件仍为 `sandbox="allow-scripts"`，未加入 `allow-same-origin`，宿主权限判断与生产 RPC 桥接不变。由于标准驱动无法从父文档访问不透明来源的 iframe，测试窗口在所有 frame 的初始化阶段注入操作代理，通过校验父子窗口和实例 token 的消息转发到对应 frame 内执行。

代理实际查找并操作 DOM 控件，走页面现有事件处理、确认状态和生产 IPC；不会把“点击断开”映射成直接调用 `bastionStop`。禁用、隐藏、过期引用、非唯一目标和模态框外的操作会被拒绝。

所有页面操作明确返回 `mode: synthetic-dom`，事件 `isTrusted=false`。程序化 click/focus 和填表不能证明系统鼠标命中测试、真实键盘路由、原生 first responder、IME、Tab 默认行为或屏幕显示正确。页面 focus 也不能替代系统焦点。原生目录框和授权框不在此代理范围内，超时不能重放破坏性操作。

验证分层：后端真实业务结果、WKWebView 页面交互、系统输入与窗口行为分别留档。测试构建通过后，正常安装版仍需少量原生冒烟；测试驱动通过不能冒充未改造安装包的所有原生操作通过。

相关上游：[Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/)、[WebdriverIO 插件设置](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup)。
