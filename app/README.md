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

HTML、CSS 和渲染层 JavaScript 修改后会自动刷新，Electron 开发窗口与浏览器预览共用同一份页面。浏览器模式会读取真实的 `config.json`，并通过仅绑定 `127.0.0.1` 的开发接口扫描本机应用、提取 macOS 原生图标；剪切板仍使用固定预览数据。全局快捷键、系统剪切板、自动粘贴和启动应用等原生能力仍需在 Electron 中验证。

只需要浏览器预览、不启动 Electron 时：

```bash
npm run dev:web
```

## 自定义

- **导航配置**：可以在 app 的配置管理中编辑，也可以继续编辑项目根 `config.json`。
  配置管理支持结构化编辑和 JSON 编辑：目录增删、同级排序、链接、备注、图标、强调色、工作台标题和链接探测开关。
  app 与 Web 管理台共用同一份 `config.json`；主进程每次呼出都会重新读取，改动即时生效，无需重启。
- **功能模块**：配置窗口已将“网页管理”作为独立模块，备忘录和剪切板入口已预留，后续可以在同一套 app 框架中扩展。
- **剪切板**：app 会轮询系统剪切板并记录文本和图片；记录保存在 Electron 用户数据目录下的 `clipboard/weborg.db`，图片文件单独保存在 `clipboard/images/`。相同类型和内容使用 SHA-256 hash 去重，并累计复制次数。
- **常用与最近入口**：成功打开应用或网页后会写入同一个 SQLite 数据库；使用次数达到 3 次才进入“常用入口”，并按 30 天半衰期计算热度；“最近使用”按最后打开时间排序，和常用入口自动去重。
- **快速打开应用**：搜索浮窗会扫描 macOS 的 `/Applications`、`/System/Applications` 和用户应用目录，使用系统原生图标展示应用，回车或点击即可打开；也可以切换到“应用”范围单独搜索。
- **本地应用/命令**：后续版本的节点支持配置本地可执行路径，通过 `openLocal` 启动。

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
  main.js        # Electron 主进程：全局快捷键、窗口、读配置、打开链接
  preload.js     # contextIsolation 桥接，安全暴露 IPC
  ui/            # 搜索框界面
    search.html
    search.js
  package.json
```
