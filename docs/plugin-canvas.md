# 桌面组件画布与插件页面

FlowHub 管理透明窗口、卡片位置与尺寸、置顶、右键菜单、插件选择和窗口生命周期。卡片内容、业务编辑器、详情与历史曲线由插件包中的 HTML/CSS/JS 提供。机器指标名称、单位、图表及查询逻辑不再放在宿主中。

点击卡片打开独立详情窗口，右键编辑或移除，Enter 打开、Shift+F10 打开菜单。拖动卡片调整位置，边角手柄自由缩放；松手后自动靠拢，间距 10 px。布局和插件配置保存在 `plugin-canvas.json`。旧布局的 `view`、`row`、`metrics` 会作为初始配置交给插件，原有尺寸和坐标保留。编辑保存后使用通用 `config` 对象。

## 插件声明

在 `flowhub-plugin.json` 中声明：

```json
{
  "statusSurface": true,
  "widget": {
    "card": "widget-card.html",
    "editor": "widget-editor.html",
    "detail": "widget-detail.html"
  }
}
```

入口路径相对于主 UI 页面的目录，必须指向包内 HTML，拒绝目录穿越和越界符号链接。组件列表发现所有已启用且声明 `widget` 的插件，不要求 `statusSurface`；后者只用于可选的状态缓存和菜单栏监控。添加时先选择插件，再加载该插件的配置页面。没有声明的旧插件保留已有布局并提示升级。新增文件随插件包发布；此次需升级一次宿主，以后修改机器卡片、指标配置或曲线只需发布机器插件。

## 页面通信

宿主以 `sandbox="allow-scripts"` iframe 加载插件页面，不开放同源访问、弹窗、表单提交或宿主 IPC。默认卡片 iframe 仅展示内容，由宿主处理点击和拖动；编辑器和详情 iframe 可交互。

需要在卡片内操作时，插件可在 `widget` 中声明 `interactive: true`。宿主为此类卡片保留顶部 24px 拖动/右键编辑区域，iframe 接收其余区域的鼠标和键盘事件。默认尺寸为 384×360，已有小卡片至少扩至 320×280，列表可在卡片内滚动。普通机器卡片保持原有行为。

状态更新通过已有 iframe 的 `flowhub:widget-init` 传入新上下文，不因定时刷新重新加载页面，避免打断输入、确认框和执行中的 RPC；布局或插件页面定义变化时才重新挂载。插件应在执行操作期间保留确认的目标，不用新快照替换用户正在确认的内容。

`widget-frame.js` 与插件自己的 `widget-bridge.js` 使用 postMessage 通信。每次挂载生成随机 token，通过 URL fragment 传给页面；双方同时验证消息窗口和 token，避免切换来源后旧页面继续调用接口。

- `flowhub:widget-ready` / `flowhub:widget-init`：传递 `{config,title,snapshot,preview}`。
- `flowhub:widget-save` / `flowhub:widget-config`：请求校验并保存插件配置，错误显示在宿主编辑器中。配置必须是最多 64 KiB 的对象。
- `flowhub:widget-rpc` / `flowhub:widget-result`：宿主将请求送至绑定插件的固定 `widget_api` 方法，页面不能指定其他插件或其他 RPC 方法。详情窗口在原生侧也绑定插件身份，关闭后移除绑定。

插件决定 `widget_api` 的动作语义。机器插件目前只开放 `history`，读取本地 SQLite，返回 `{data,unit}`；不开放命令执行或配置写入。图表缺失采样保留空档。Docker 插件另外提供停止目标预览和显式确认接口，重新校验本机环境及容器集合，并逐个核实停止结果；宿主不解释 Docker 命令。

## 状态与预览

宿主每 15 秒读取插件已有 `status_snapshot` 缓存，不额外启动远程采集。状态行的 `summary` 由插件格式化，供原生菜单栏使用；宿主仅处理通用状态和名称。`values` 的意义及渲染由插件决定。

浏览器使用 `plugin-canvas.html?preview=http://127.0.0.1:5182/`，从该插件的 `widget-preview.json` 加载页面定义和模拟状态，布局只保存在 localStorage，不调用原生功能。预览数据也属于插件。
# 对象详情导航

交互式组件可向宿主发送 `flowhub:widget-navigate`，指定 `action: "detail"` 和可选对象 `selection`（JSON 对象，最多 4096 字符）。宿主核对 iframe 来源与令牌，将选择放入详情配置的 `config.selection`；插件 ID 仍由宿主绑定，不接受消息覆盖。`action: "editor"` 打开当前组件编辑器。Docker 用此传递容器 ID、Compose 项目或镜像页面及 Docker context，详情页核对当前环境后定位对象。
