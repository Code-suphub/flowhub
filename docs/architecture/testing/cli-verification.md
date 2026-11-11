# CLI 与原生验收

先确认要验证的层级，再选择入口。命令由 CLI 发起，不意味着它不使用系统桌面，也不意味着它连接的是正常安装版。

| 入口 | 能验证 | 不能据此宣布通过 |
| --- | --- | --- |
| 项目测试、构建、包资源检查与只读后端 RPC | 业务逻辑、协议、资源与真实后端返回 | 页面点击、原生焦点、安装替换 |
| `flowhub-cli.mjs` | 旧 HTTP 目录与本机诊断 | 桌面 SQLite 配置、插件安装、页面按钮 |
| checkout 中可用的 `flowhub-ui-test.mjs` | 隔离 WKWebView 内页面控件、生产桥接与后端调用 | 普通安装版、系统输入、IME、原生目录框 |
| `toolkit desktop`／Computer Use | 正常安装版的窗口、AX、截图和原生操作 | 未实际执行的硬件输入、热插拔或跨屏场景 |

## 项目 CLI

在仓库根查看已有命令，不会启动宿主或写用户配置：

```sh
node app/scripts/dev/flowhub-cli.mjs help
```

HTTP 配置命令依赖旧目录服务，默认地址为 `http://127.0.0.1:4173`，不是 Tauri 正式宿主的控制端口。诊断 CLI 中 `diagnose`、`monitor sample` 会落盘，启停监测和清空诊断同样是写操作，按任务范围使用。

## 安装版后台插件迁移

支持 `FlowHubPluginCLIProtocol=1` 的 macOS 安装版提供后台插件维护入口，启动主程序后运行：

```sh
node app/scripts/dev/flowhub-cli.mjs plugin list
node app/scripts/dev/flowhub-cli.mjs plugin migrate docker --dry-run
node app/scripts/dev/flowhub-cli.mjs plugin migrate docker
node app/scripts/dev/flowhub-cli.mjs plugin verify docker
```

`FLOWHUB_APP` 可指定应用包路径，默认 `/Applications/FlowHub.app`。CLI 先检查应用能力，旧版不会收到未知参数而意外唤出搜索窗口。原生客户端在初始化 Tauri 前处理参数，通过仅当前用户可访问的 Unix socket 连接同一安装程序的宿主；服务器双向核对用户和进程路径。命令不会发送系统鼠标／键盘事件。

迁移只处理已登记的本地插件，同版本、同权限、同文件内容搬到 `~/Library/Application Support/FlowHub/local-plugins/<id>`，拒绝覆盖不同包或接收新插件。先校验并复制，之后由宿主持有插件管理锁、更新登记并重载目标进程。失败恢复原登记及进程。插件数据仍按原 ID 保存，验证码邮件监控留在宿主。`--dry-run` 不创建目录、不重载、不写登记；`verify` 检查包、健康协议及已声明的只读状态，停用插件保持停用。

`verify` 可能按正常宿主流程启动尚未运行的已启用插件；它不启用被停用的插件。该入口是正式维护能力，不能调用任意业务 RPC、读取验证码或凭证，也不能代替安装版的页面点击、IME 或键盘焦点验收。迁移后核对 CLI 返回、磁盘登记、进程路径、包指纹与原有配置，再清理旧目录。

## 隔离 WKWebView 驱动

先检查当前 checkout 是否具有 `app/scripts/dev/flowhub-ui-test.mjs` 及配套的 `docs/architecture/testing/ui-test-cli.md`。存在时阅读其完整隔离要求，并执行：

```sh
node app/scripts/dev/flowhub-ui-test.mjs help
```

每次指定自己的夹具目录和会话文件；不指向正式 FlowHub 数据，不复制真实 SSH 凭证或用户密钥作为夹具。操作必须走页面控件与既有业务链路，不能把“按钮验证”替换成直接调用后端函数。

`synthetic-dom` 中的 click／fill／key 可验证页面事件处理；它们不能证明系统 first responder、真实 Tab 默认行为或键盘输入目的地。专用构建导入插件包只是准备夹具，不算正常插件市场安装成功。停止本次测试实例，不关闭其他会话的进程。

## 正常安装版的桌面 CLI

环境已安装 toolkit 时，先发现后端并读取其当前指南：

```sh
toolkit desktop backends
toolkit desktop guide --backend huashu
toolkit desktop huashu mac -- windows FlowHub
toolkit desktop huashu mac -- idle
```

没有适用后端时使用已有 Computer Use；不要为完成一个测试自动安装或改造全局工具。以下为 Huashu 的操作模板，尖括号内容必须替换为本轮读取的目标和 Git 外证据路径：

```text
toolkit desktop huashu mac -- see <window-id> --out <evidence.png>
toolkit desktop huashu mac -- op <window-id> <x> <y> "" --dry
toolkit desktop huashu mac -- op <window-id> <x> <y> "" shot <after.png>
```

先确认目标控件、坐标系、遮挡和用户在场状态，再执行已授权的实际操作。窗口截图可能包含父窗口或同应用的其他窗口，必须核对截图范围与窗口收据，不能把组合图片直接当作目标窗口的坐标系。

操作后读取选中页、字段、弹窗、结果列表等实际状态；保存或安装还要核对持久化或进程等副作用。返回成功、差分 `confirmed` 不代表业务正确，`suspected_noop` 或超时也不代表操作没有发生。先读回再决定下一步，不重放可能已生效的写操作。

原生目录框的自动化可能失效；无法可靠读取或操作时请求明确的人工协助，不能盲点默认按钮、篡改运行中注册文件或启用正式版测试后门。既有替换授权继续有效，无需重复请求同一授权。

## 替换与证据

1. 备份要替换的应用／插件包及相关注册信息，确认目标目录、版本和权限范围。
2. 按正常安装或插件更新流程只替换目标，不改其他插件；仅更新插件时优先保留宿主进程。
3. 核对注册版本／目录、构建文件指纹、实际运行程序路径及父子进程关系，再读取正常页面的真实数据。
4. 补原生冒烟：实际打开与输入、弹窗 Tab／Shift+Tab／Esc、关闭后的焦点和相关跳转。IME、全局快捷键、系统授权、多屏与热插拔按实际条件分别留档；缺条件则保留待验。
5. 每次代码或构建变化后重新验证受影响项目，记录版本、提交、驱动模式、结果、受干扰／待验项和证据位置。原始截图、用户数据、会话文件和日志放 Git 外；测试收尾恢复自身修改的临时状态。

锁屏时继续代码、构建、包和后台数据检查；不能把后台截图或隔离测试解释为原生交互通过。用户或其他会话切走窗口时停止该轮输入，待条件满足后重新验证。
