# FlowHub 页面设计库

[打开 FlowHub Plasmic 项目](https://studio.plasmic.app/projects/rKroot8WmpiogJg8366SaB)。项目位于原有工作区，与 Flowbook 项目独立；页面目录为 `/`。

设计来自主体、浏览器扩展和六个插件的实际 React / HTML 界面。数据使用项目已有只读示例，或独立的合成 API；不读取正常安装版的账户、剪贴板、机器配置或设备数据。原生窗口、系统权限和业务操作仍由现有源码负责。

首批录入 110 个页面、组件和状态，其中 62 个有独立页面路径。六个插件为外设中心、应用资源监控、机器管理、Docker、验证码和社交中心；详情、桌面卡片、编辑器及主要弹窗分别保留为可编辑视图。

文字、表单、列表和布局是 Plasmic 元素；图标与曲线保留为内嵌 SVG 资源。共享语义颜色映射 `--fh-*` 调色板。当前基线以浅色、桌面视口为主，来源与已记录的捕获尺寸见 [project.json](./project.json)，入口对应关系见 [pages.md](./pages.md)。这份设计副本不接管应用运行时；Studio 修改按对应源码逐项评审和实现。

## 本地目录

- `project.json`：项目 ID、源码版本、页面 / 组件清单与合成数据来源，不含认证信息或页面用户数据。
- `pages.md`：可读的页面与源码对应表。
- `sync.mjs`：只向这个 FlowHub 项目追加审核过的原生元素；默认仅检查本地目录。
- `assemble.mjs`：将明确标记为公开夹具的导出合并到 Git 外的私有目录，同时刷新页面索引。

完整 DOM 导出、项目读回、截图、临时浏览器资源、日志和认证文件保存在 Git 外。生产构建与启动不访问 Plasmic。

## 检查与补录

```sh
node --test design/plasmic/sync.test.mjs
node design/plasmic/sync.mjs

# 合成导出必须带 source.fixture=true。此命令不写 Plasmic。
node design/plasmic/assemble.mjs /absolute/path/to/reviewed-fixture-exports.json

# 设置既有的私有 .plasmic.auth 文件位置；不要把 token 写进命令或仓库。
export PLASMIC_AUTH_FILE=/absolute/path/to/private/.plasmic.auth
node design/plasmic/sync.mjs --library "$HOME/.local/state/flowhub-plasmic/library.json"
node design/plasmic/sync.mjs --library "$HOME/.local/state/flowhub-plasmic/library.json" --apply
```

默认追加时跳过已有名称，保留 Studio 的修改。确需替换已有组件正文时加 `--update-existing`，并先核对导出与 Studio 差异；工具要求远端 revision 与上次 Git 外回执一致。检测到其他 Studio 修改后应先导出并合并，不应改写回执绕过保护。没有自动双向同步。

每批写入后读回项目，核对组件名称并原子保存回执到 `~/.local/state/flowhub-plasmic/import-receipt.json`。请求失败或超时后，先读取远端实际内容，再判断是否继续；工具不自动重放写入。

录入验收包含本地结构检查、远端名称 / 路径和节点读回、Plasmic codegen、独立浏览器渲染及关键字段核对。合成页面与设计导出不能替代安装版的鼠标命中、系统焦点、中文输入法、双屏、硬件或危险操作验收。
