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

## 主体布局自动预览

运行时联动使用单独的“联动 · 主体…”组件，原 110 个设计视图保留。联动组件以原来的公开夹具作为底图，HTML ID 为 `flowhub-layout-root`、`flowhub-layout-header` 等的区域对应实际页面；完整映射见 [layouts.json](./layouts.json)。设置的十二个分类共用设置壳，启动器各分类共用搜索壳。文字、数据、事件和动态显隐仍由原组件负责。

在 `app/` 执行：

```sh
export PLASMIC_AUTH_FILE=/absolute/path/to/private/.plasmic.auth
pnpm plasmic:dev
```

主体预览使用 `http://127.0.0.1:5200/search.html?preview=demo`，其他入口如 `settings.html?preview=demo`、`plugin-market.html?preview=demo`。每三秒检查保存版本，有变化时仅将已绑定区域的样式差异生成到本地 `app/ui/shared/plasmic-layouts.css`，通过 Vite 更新 CSS；角落显示同步状态。无需发布 Plasmic，也不会构建或更新安装版。

在 Plasmic 修改带上述 ID 的区域的间距、颜色、字号、尺寸或布局属性后保存。新增节点、修改文案、未绑定区域、变体或业务结构会提示需要代码适配，并保留上次预览；不能将设计示例误当业务数据。初始样式基线不覆盖现有响应式布局，恢复设计基线会撤回本次覆盖。带 URL 的资源与可执行内容不参与同步。

`pnpm plasmic:sync --check` 离线核对文件，`pnpm plasmic:sync --apply` 单次拉取。源文件有手改时停止自动覆盖。普通 `dev:web`、构建与安装版不启动监听；独立预览不能替代原生窗口、焦点、IME 与双屏验收。按模块进度和证据入口见 [接入清单](../../docs/tasks/plasmic-auto-modules.md)。

每批写入后读回项目，核对组件名称并原子保存回执到 `~/.local/state/flowhub-plasmic/import-receipt.json`。请求失败或超时后，先读取远端实际内容，再判断是否继续；工具不自动重放写入。

录入验收包含本地结构检查、远端名称 / 路径和节点读回、Plasmic codegen、独立浏览器渲染及关键字段核对。合成页面与设计导出不能替代安装版的鼠标命中、系统焦点、中文输入法、双屏、硬件或危险操作验收。
