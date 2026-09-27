# FlowHub

FlowHub 是 macOS 本地启动器：全局快捷键呼出浮窗，搜索并打开应用、网页目录、剪贴板历史和备忘命令。正式应用是基于 Tauri 2 的桌面程序，本仓库同时保留 Chrome 扩展和一个已冻结的旧 Web 管理台。

## 目录结构

```text
flowhub/
  app/              Tauri 桌面应用（宿主）：ui/、src-tauri/、scripts/
  extension/        Chrome 扩展：side panel、popup、new tab、页面内浮窗
  legacy/           旧 Web 管理台：index.html + 本机 server.mjs（只支持 schema 1 目录）
  docs/
    architecture/   当前架构与协议说明（按主题分组）
    tasks/          进行中的任务清单
  config.json       配置示例，legacy server 与浏览器预览共用
  start.command     双击启动 legacy 本机管理台
```

日常开发、构建和发布都以 `app/` 为中心，详见 [app/README.md](app/README.md)、[AGENT.md](AGENT.md) 和 [docs/](docs/README.md)。

## 快速开始

```sh
cd app
npm install
npm start          # 需要 Node.js 22+、Rust stable 和 Xcode Command Line Tools
```

只预览前端页面时可以运行 `cd app && npm run dev:web`；浏览器不具备全局快捷键、剪贴板监听和打开本机应用等原生能力。

旧 Web 管理台：双击 `start.command`，或在仓库根目录运行 `npm start`，随后访问 `http://127.0.0.1:4173/`。

## 测试

```sh
npm test                  # 仓库根：legacy server 与 legacy 目录契约
cd app && npm test         # 桌面应用：Rust + UI + 浏览器预览 + 安全边界
```

## 插件

FlowHub 官方插件在独立仓库维护：<https://github.com/Code-suphub/flowhub-plugins>。宿主的 `npm run dev:machines` 是同級克隆的开发快捷入口，默认查找 `../../flowhub-plugins`，可用 `FLOWHUB_PLUGINS_DIR` 指向其他位置：

```sh
cd app
FLOWHUB_PLUGINS_DIR=/path/to/flowhub-plugins npm run dev:machines
```
