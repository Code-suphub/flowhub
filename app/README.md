# Web Organization 桌面启动器

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

## 自定义

- **导航配置**：可以在 app 的配置管理中编辑，也可以继续编辑项目根 `config.json`。
  配置管理支持结构化编辑和 JSON 编辑：目录增删、同级排序、链接、备注、图标、强调色、工作台标题和链接探测开关。
  app 与 Web 管理台共用同一份 `config.json`；主进程每次呼出都会重新读取，改动即时生效，无需重启。
- **功能模块**：配置窗口已将“网页管理”作为独立模块，备忘录和剪切板入口已预留，后续可以在同一套 app 框架中扩展。
- **本地应用/命令**：后续版本的节点支持配置本地可执行路径，通过 `openLocal` 启动。

## 冒烟测试（无 GUI 验证）

```bash
WEBORG_SMOKE_TEST=1 npm start
```

主进程启动后自动退出，打印全局快捷键注册结果，用于 CI / 无图形环境验证。

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
