# 剪贴板记录：留存、清理与高频操作

记录落在当前存储目录的 `weborg.db`（表 `clipboard_records`，`UNIQUE(kind, hash)`），图片副本在 `images/<hash>.png`。同一内容再次复制只刷新 `last_seen_at` 并累加 `copy_count`。

## 清理规则

`plugins.clipboard.settings` 控制留存：

- `retentionDays`（默认 30，0 表示不限）：`last_seen_at` 早于窗口的记录会被删除。
- `maxRecords` / `maxBytes`（默认 0，表示不限）：按 `last_seen_at` 从新到旧排序后，超出条数或逻辑字节数的记录会被删除。逻辑字节数按文本 UTF-8 长度、PNG 大小、文件路径序列化长度计算，不含原始文件自身大小，也不含 SQLite 页与索引开销。
- 清理在空闲超时和每次排队任务之前执行，单批最多 `CLEANUP_BATCH` 条；删除图片记录后会顺带清掉没有引用的托管图片，不删除用户自己的文件。

## 置顶（收藏）

`pinned_at` 为置顶时间，为空表示未置顶。

- 置顶记录排在未置顶记录之前，同一组内仍按 `last_seen_at` 从新到旧。
- 过期、条数、容量三条规则只作用于 `pinned_at IS NULL` 的记录：置顶内容不会被清理误删，也不占用这三项预算。置顶本身没有条数上限。
- 旧数据库没有这一列，启动时由 `initialize_schema` 按 `PRAGMA table_info` 补 `ALTER TABLE`；`validate_existing_storage` 的必需列集合保持不变，已有记录不受影响。

## 高频操作与快捷键

搜索结果里每条剪贴板记录提供按钮与等价快捷键：

| 操作 | 按钮 | 快捷键 | 说明 |
| --- | --- | --- | --- |
| 粘贴 | 回车 / 点击 | `↩` | 文本写文本、文件写文件、图片写图片 |
| 纯文本粘贴 | 纯文本粘贴 | `⇧↩` | 只写文本内容：文本记录写正文，文件记录写绝对路径（换行分隔），图片记录不可用并给出提示 |
| 置顶 / 取消置顶 | ☆ 置顶 / ★ 取消置顶 | `⌘D` | 完成后重新取第一页，列表顺序随之变化 |
| 编辑副本 | 编辑副本 | `⌘E` | 行内编辑文本，保存为一条新记录，原记录保留；`⌘↩` 保存、`Esc` 取消 |
| 备注 | 添加／编辑备注 | 编辑框 `⌘↩` / `Ctrl↩` | 修改当前记录的可搜索备注；不改变原文，`Esc` 取消 |
| 删除记录 | — | `⌥⌫` | 只删历史记录与托管图片副本，不删原始文件 |

约束：浏览器预览（`data-weborg-readonly`）下这些操作都会被拒绝并提示；`⌘D`／`⌘E`／`⇧↩` 只在选中项是剪贴板记录时生效。编辑副本期间键盘归编辑框，`Esc` 取消而不是隐藏窗口。纯文本粘贴与编辑副本写库前都会按文本指纹抑制回采，避免复制出的内容立刻变成一条新记录。

## 组织与筛选

剪贴板范围支持类型、只看置顶与已保存来源组合筛选，条件在原生 SQL 的 `LIMIT/OFFSET` 之前应用。`source = null` 表示全部来源，空字符串表示未标注来源；来源只比较保存的 `source_name`，当前采集不会推测写入应用，也不将来源当作隐私排除依据。来源列表按需异步读取名称／条数，在剪贴板更新时刷新，不在逐字输入路径中扫描数据库。切换全部范围会重新获取未筛选结果；筛选结果不污染全部范围的空查询缓存。

`note TEXT NOT NULL DEFAULT ''` 由启动时的增量补列迁移添加，旧存储必需列集合保持不变。备注最多 500 字符，保存时校验打开编辑器时的旧值，记录被删除或备注已变更会拒绝并保留草稿。仅主体／设置窗口可调用备注和来源接口。备注不修改正文、指纹、创建／最近时间或复制次数；再次复制同内容保留备注。结果副标题与预览单独展示备注，复制／粘贴仍取原文。

搜索历史记录并恢复类型、来源与置顶条件，旧历史默认全部来源、非仅置顶。筛选重置一次性恢复全部类型／来源与置顶条件，原查询不变。采集设置按钮直达现有剪贴板设置；临时忽略下一次复制仍为后续增强，本轮没有新增采集豁免规则。

浏览器预览的来源接口只读，搜索兼容没有备注／置顶列的旧库，不进行迁移；备注写入始终拒绝。原生接口与预览搜索都在翻页前应用筛选。

## 隐私：暂停与按来源排除

- **持久暂停**：设置页剪贴板面板的「暂停采集」（`plugins.clipboard.settings.capturePaused`）保存后生效；剪贴板插件关闭（`enabled: false`）等同于暂停。暂停期间不写入记录，也不会重放恢复基线之前的剪贴板版本。
- **按来源排除**：macOS 没有可信的剪贴板写入方身份（前台应用与 `org.nspasteboard.source` 都不构成证据）。因此 `excludedApps` 非空时后端保守地**阻止全部采集**，不会按猜测放行；配置里存在旧排除名单时，设置页会说明原因并提供「清空旧列表并保存」。
- **敏感格式**：`protectSensitive`（默认开）会跳过剪贴板中的密码管理器／临时标记格式（`org.nspasteboard.ConcealedType` 等），与暂停互相独立。

## 验证

```sh
cargo test --manifest-path app/src-tauri/Cargo.toml clipboard:: --lib
cargo test --manifest-path app/src-tauri/Cargo.toml storage::tests::existing_databases --lib
node app/scripts/tests/clipboard-actions.test.cjs
node app/scripts/tests/search-focus.test.cjs
node --test app/scripts/tests/clipboard-organization.test.cjs
node --test app/scripts/tests/clipboard-preview.test.mjs
```

Rust 测试覆盖置顶排序与三类清理豁免、编辑副本保留原件、纯文本取文本规则、旧库补列不丢数据、筛选后翻页、备注更新冲突／长度／空值校验、再次复制保留备注、主体窗口边界，以及被暂停或被排除名单阻止的采集既不写数据库也不生成缩略图文件；JS 测试覆盖按钮与快捷键、备注草稿／IME／失败保留、搜索历史条件、旧库只读及筛选缓存隔离。真实剪贴板写入、系统粘贴、图片/文件记录的行为以及真实 WKWebView 仍按[安装版验收清单](../../tasks/launcher-desktop-acceptance.md)单独验证。
