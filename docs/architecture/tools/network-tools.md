# 内置网络工具

- `ping example.com` / `ping 127.0.0.1` / `ping ::1`：4 次探测，进程最长 8 秒，展示原始统计输出。
- `curl https://example.com`：GET 响应头及正文预览。
- `curl -I https://example.com`：HEAD 响应头。仅支持这两个简化格式，不接受任意 curl 参数。

输入后按回车或点击执行，结果保留在悬浮窗。可复制输出和查询命令；IPv6 ping 的 macOS/Linux 命令分别生成。GET/HEAD 请求不自动跟随重定向，curl 超时 10 秒，进程最长 12 秒；正文限制 64 KiB，stdout/stderr 各保留最多 32 KiB。进程只读标准输入空流，忽略 curlrc，不启动 shell；只允许 HTTP(S)，拒绝 URL 内嵌账号密码。一次只运行一个网络诊断，重复点击不叠加执行；切换查询不会显示旧结果，原生任务仍会运行至完成/超时。

`network-tools.js` 使用 FlowHubTools 注册独立 ping/curl 模块；设置页支持分别启停。Rust `network_diagnostics.rs` 承担本机执行和边界限制。属于随应用发布的内置模块，还没有第三方安装和热加载生命周期。

执行过的命令进入本机历史（`ui/shared/command-store.js`，每个工具 20 条），结果里的「最近执行」可重新执行、复制实际命令、移除或清空，并能把当前查询存成参数模板（主机／URL，每工具 10 个）。记录开关是 `plugins.tools.settings.commandHistory`（默认开）；URL 里的账号密码、token／api_key 等密钥参数与 `Authorization` 头不写入。回放与复制前重新过 `parse`，不合法的记录不会执行。

验证：本地 HTTP 服务、127.0.0.1 Ping、非法参数、输出截断、前端回车执行、重复抑制、旧响应丢弃、开关和命令复制；`app/scripts/tests/command-store.test.cjs` 覆盖历史条数上限、去重、清空与敏感内容过滤，`command-tools.test.cjs` 覆盖执行后记录、回放、模板与关闭开关。浏览器界面使用合成响应；未将合成响应当作公网测量。命令历史与模板存在搜索窗口的本地存储里，跨重启保留与多窗口共享尚未在真实 App 中验证。

适合后续扩展：TCP 连通性（tcp host port）、DNS 查询细节、traceroute、TLS 证书/到期时间、whois、HTTP 分阶段耗时，以及离线 hash/Base64/URL 编解码。DNS/IP 已有入口，可先统一它们的交互。
