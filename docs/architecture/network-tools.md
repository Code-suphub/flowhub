# 内置网络工具

- `ping example.com` / `ping 127.0.0.1` / `ping ::1`：4 次探测，进程最长 8 秒，展示原始统计输出。
- `curl https://example.com`：GET 响应头及正文预览。
- `curl -I https://example.com`：HEAD 响应头。仅支持这两个简化格式，不接受任意 curl 参数。

输入后按回车或点击执行，结果保留在悬浮窗。可复制输出和查询命令；IPv6 ping 的 macOS/Linux 命令分别生成。GET/HEAD 请求不自动跟随重定向，curl 超时 10 秒，进程最长 12 秒；正文限制 64 KiB，stdout/stderr 各保留最多 32 KiB。进程只读标准输入空流，忽略 curlrc，不启动 shell；只允许 HTTP(S)，拒绝 URL 内嵌账号密码。一次只运行一个网络诊断，重复点击不叠加执行；切换查询不会显示旧结果，原生任务仍会运行至完成/超时。

`network-tools.js` 使用 FlowHubTools 注册独立 ping/curl 模块；设置页支持分别启停。Rust `network_diagnostics.rs` 承担本机执行和边界限制。属于随应用发布的内置模块，还没有第三方安装和热加载生命周期。

验证：本地 HTTP 服务、127.0.0.1 Ping、非法参数、输出截断、前端回车执行、重复抑制、旧响应丢弃、开关和命令复制。浏览器界面使用合成响应；未将合成响应当作公网测量。

适合后续扩展：TCP 连通性（tcp host port）、DNS 查询细节、traceroute、TLS 证书/到期时间、whois、HTTP 分阶段耗时，以及离线 hash/Base64/URL 编解码。DNS/IP 已有入口，可先统一它们的交互。
