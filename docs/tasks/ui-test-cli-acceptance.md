# 页面验收 CLI 任务与检查清单

实现分支：`codex/ui-test-cli`。使用独立 worktree，不修改本地 main 或当前安装版。使用方法与覆盖边界见[架构说明](../architecture/testing/ui-test-cli.md)。

- [x] 可选构建与独立测试入口；普通宿主无测试驱动依赖、无测试服务。
- [x] 独立数据目录、实例标记、回环驱动、进程身份校验及正常停止。
- [x] 不改变插件 sandbox 或生产 RPC 校验，支持不透明来源 iframe 内的页面操作。
- [x] JSON CLI：inspect、click、fill、key、read、wait、screenshot、run、stop。
- [x] 禁用／隐藏／模态框外／非唯一／过期引用拒绝；异步等待、失败截图与步骤报告。
- [x] 测试构建的 RPC 阶段、耗时和成败日志，不记录命令、输出或凭据。
- [x] 实际 macOS WKWebView 的机器管理完整流程：最终 58 步计划通过。
- [x] 页面断开确认不会立即断开；取消保留连接，确认后真实 TCP 连接消失，显式重连查询成功。
- [x] 页面保存端口 A→B；保存完成后新目标不携带旧草稿，旧会话报错但仍能通过按钮断开；新查询返回 B，重开编辑器仍显示 B。
- [x] 负向计划点击已禁用的断开按钮，准确返回 control-disabled、非零退出码，并生成 failure.png。
- [x] 实际 HTML dialog 背景按钮被拒绝；关闭弹窗后旧引用因仍挂载但隐藏而被拒绝，不误记为节点已销毁。
- [x] 最终构建的空插件市场实例可由 CLI 打开“插件市场更多操作”菜单；没有触发系统目录选择框。
- [x] 测试程序、SSH 会话、两个回环监听及临时主机密钥记录已清理；测试私钥删除，原 known_hosts 字节恢复。
- [x] 复跑前后核对正式 plugins.json、机器 state.json 和共享 SSH 配置 SHA-256 均未变化。
- [ ] 系统目录选择框、系统授权框、真实鼠标命中、全局快捷键、输入法、系统焦点与多屏；这些不因页面 CLI 通过而关闭待验。

## 验证记录

2026-11-07 使用机器管理 0.4.0 的真实前端与原生后端，插件二进制 SHA-256 为 `ce19b551e011141ac73ff47e03b68a7cd845fd7d043499ec0d81b9b0b39fb624`。完整流程通过页面控件、确认状态及生产 IPC，未使用 Computer Use；测试事件明确为 `synthetic-dom`、`isTrusted=false`，不能冒充真实系统输入。

应用 `npm test` 完整通过；后续新增／修订的 CLI 专项共 12 项通过，Cargo feature 的隔离校验专项通过，类型与 UI 资源构建通过，`git diff --check` 通过。正常 feature 的依赖树无 wdio，驱动只在明确的测试构建中启用。

首次 CLI 验收的根目录 `npm test` 有一项 legacy 回环监听边界子测试失败：监听仅绑定 127.0.0.1，但本机 198.18.0.1 也可连通。当时 legacy 服务与测试文件均未修改，结果按实际失败留档。

后续确认运行中的 Mihomo TUN 会转发虚拟网卡地址到回环。按用户授权修正测试：通过仅测试使用的预加载器／私有 IPC 断言真实监听地址，非回环请求的实际响应必须由回环 socket 接收且拒绝非法 Host；受控转发 fixture 验证 Host、Origin 和写入令牌。未排除 TUN 网卡、跳过断言或调整代理配置；`legacy/server.mjs` 不变。测试方法见[旧 Web 服务访问边界](../architecture/legacy/legacy-web-security.md)。

修复后在 TUN 保持开启的环境中，根目录 `npm test` 的 16 项测试全部通过，`cd app && npm test` 完整通过，`git diff --check` 通过。临时副本故意把服务监听改为 `0.0.0.0`，监听断言准确报告实际地址不符并返回非零退出码，确认没有放宽错误绑定检查；临时副本随后清理。修复验收证据保存在 `/Users/bilibili/.local/state/flowhub-network-audit/test-fix-20261107-021147`，包含两级回归日志及故障注入结果；此前环境失败项已关闭。

私有证据：`/Users/bilibili/.local/state/flowhub-ui-test-cli/20261107-014700`，包含最终计划、逐步报告、真实 WKWebView 截图、RPC 日志、负向计划与失败截图、清理结果及各项测试日志。私钥、用户数据、截图与日志不进入 Git。
