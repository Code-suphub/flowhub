# FlowHub 桌面启动器

类 uTools 的桌面全局搜索框。不依赖浏览器扩展，作为独立桌面 App 运行：
按 **Alt+Space** 呼出一个无边框置顶搜索浮窗，输入即可搜索目录/网页/备注，
回车用系统默认浏览器打开目标页面。自带的 `config.json`（项目根）决定导航内容。

## 依赖

- Node.js + npm
- Electron（作为 devDependency，首次需下载二进制）

## 安装

```bash
cd app
npm install
```

首次安装 Electron 下载较慢；如网络受限可指定镜像：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install
```

## 运行

```bash
cd app
npm start
```

启动后不会有常驻窗口；按 **Alt+Space** 呼出搜索框：

- 输入关键词过滤目录/网页/备注
- `↑` / `↓` 选择，`Enter` / 点击打开
- `Esc` 关闭浮窗
- 点击搜索框右上角的 `⚙` 打开配置管理

## 浏览器预览与热更新

调整搜索浮窗或配置管理界面时，使用 Vite 开发模式：

```bash
cd app
npm run dev
```

该命令会同时启动 Electron 和渲染层开发服务器。浏览器也可以直接访问：

- 搜索浮窗：`http://127.0.0.1:5173/search.html`
- 配置管理：`http://127.0.0.1:5173/settings.html`

HTML、CSS 和渲染层 JavaScript 修改后会自动刷新，Electron 开发窗口与浏览器预览共用同一份页面。浏览器模式会读取真实的 `config.json`，并通过仅绑定 `127.0.0.1` 的开发接口扫描本机应用、提取 macOS 原生图标，以及只读分页查询真实剪切板历史；剪切板首批加载 30 条，滚动接近底部时继续加载。浏览器不能复制、粘贴或删除剪切板记录；全局快捷键、系统剪切板监听、自动粘贴和启动应用等原生能力仍需在 Electron 中验证。

只需要浏览器预览、不启动 Electron 时：

```bash
npm run dev:web
```

## 自定义

- **配置结构**：`config.json` 分为 `core` 和 `plugins`。`core` 保存全局快捷键、登录时启动和配置文件位置等 App 配置；每个插件在自己的 `enabled` 和 `settings` 下保存启用状态与专属配置，不再读取旧版顶层字段。通用设置可选择新的 `config.json` 位置、在 Finder 中显示或恢复默认；App 用户目录中的 `config-location.json` 只负责记录当前配置文件的位置。
- **配置管理**：左侧先显示 App 的通用设置，再按插件清单显示可用插件、启用开关和各自的设置入口。网页插件提供目录结构与 JSON 编辑，剪切板插件提供留存策略，应用插件展示扫描范围。
- **内置插件**：网页、应用与剪切板通过统一的插件注册中心提供生命周期及 `list / search / action` 能力；搜索范围和设置模块均由 `ui/plugins.json` 生成。清单中的 `defaultEnabled` 只是默认值，用户开关以 `config.json` 为准；未注册运行时的插件会显示为未安装且不可启用。当前只加载随 App 打包并由主进程显式注册的受信任插件，不执行外部目录中的任意 Node.js 代码。
- **剪切板**：app 会轮询系统剪切板并记录文本和图片；默认保存在 Electron 用户数据目录下的 `clipboard/weborg.db`，图片文件保存在同目录的 `images/`。剪切板插件设置支持选择新的数据目录、恢复默认位置和在 Finder 中打开；切换到空目录时会复制现有数据库与图片，旧目录保留为安全备份。相同类型和内容使用 SHA-256 hash 去重，并累计复制次数。
- **常用与最近入口**：成功打开应用或网页后会写入 App 的共享 SQLite 数据库；使用次数达到 3 次才进入“常用入口”，并按 30 天半衰期计算热度；“最近使用”按最后打开时间排序，和常用入口自动去重。停用剪切板插件只停止系统剪切板监听，不影响使用记录。
- **快速打开应用**：搜索浮窗会扫描 macOS 的 `/Applications`、`/System/Applications` 和用户应用目录，使用系统原生图标展示应用，回车或点击即可打开；也可以切换到“应用”范围单独搜索。
- **本地应用**：应用插件通过受控的 `action` 接口调用系统能力启动本机应用。

## 冒烟测试（无 GUI 验证）

```bash
FLOWHUB_SMOKE_TEST=1 npm start
```

主进程启动后自动退出，打印全局快捷键注册结果，用于 CI / 无图形环境验证。

排查自动粘贴耗时时，可以开启分阶段日志：

```bash
FLOWHUB_CLIPBOARD_PERF=1 npm start
```

终端会输出记录查询、内容准备、系统剪切板写入、窗口隐藏、焦点交接和原生粘贴各阶段耗时，不会输出剪切板正文。

## 目录结构

```
app/
  plugins/registry.js # 内置插件契约、注册与统一调用入口
  ui/plugins.json     # 插件清单、排序和设置面板元数据
  main.js        # Electron 主进程：全局快捷键、窗口、读配置、打开链接
  preload.js     # contextIsolation 桥接，安全暴露 IPC
  ui/            # 搜索框界面
    search.html
    search.js
  package.json
```
