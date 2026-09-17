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
| 删除记录 | — | `⌥⌫` | 只删历史记录与托管图片副本，不删原始文件 |

约束：浏览器预览（`data-weborg-readonly`）下这些操作都会被拒绝并提示；`⌘D`／`⌘E`／`⇧↩` 只在选中项是剪贴板记录时生效。编辑副本期间键盘归编辑框，`Esc` 取消而不是隐藏窗口。纯文本粘贴与编辑副本写库前都会按文本指纹抑制回采，避免复制出的内容立刻变成一条新记录。

## 隐私：暂停与按来源排除

- **持久暂停**：设置页剪贴板面板的「暂停采集」（`plugins.clipboard.settings.capturePaused`）保存后生效；剪贴板插件关闭（`enabled: false`）等同于暂停。暂停期间不写入记录，也不会重放恢复基线之前的剪贴板版本。
- **临时暂停**：搜索窗口底部的「暂停记录」按钮调用 `set_clipboard_temporary_pause`，只在本次运行内叠加在配置策略之上，不改配置文件、不重启监控，并立即把基线刷到当前剪贴板版本——暂停期间复制的内容不会在恢复后被补采。按钮与状态文字会区分「本次运行暂停」「已在设置中暂停」「剪贴板已停用」。
- **按来源排除**：macOS 没有可信的剪贴板写入方身份（前台应用与 `org.nspasteboard.source` 都不构成证据）。因此 `excludedApps` 非空时后端保守地**阻止全部采集**，不会按猜测放行；配置里存在旧排除名单时，设置页会说明原因并提供「清空旧列表并保存」。搜索窗口的按钮此时显示「记录已阻止」且不可点击，临时暂停无法绕过。
- **敏感格式**：`protectSensitive`（默认开）会跳过剪贴板中的密码管理器／临时标记格式（`org.nspasteboard.ConcealedType` 等），与暂停互相独立。

## 验证

```sh
cargo test --manifest-path app/src-tauri/Cargo.toml clipboard:: --lib
cargo test --manifest-path app/src-tauri/Cargo.toml storage::tests::existing_databases --lib
node app/scripts/tests/clipboard-actions.test.cjs
node app/scripts/tests/clipboard-pause.test.cjs
node app/scripts/tests/search-focus.test.cjs
```

Rust 测试覆盖置顶排序与三类清理豁免、编辑副本保留原件、纯文本取文本规则、旧库补列不丢数据、临时暂停与恢复基线，以及被阻止的采集既不写数据库也不生成缩略图文件；JS 测试覆盖按钮与快捷键、只读与参数守卫、编辑态键盘、暂停入口的状态与提示。真实剪贴板写入、系统粘贴、图片/文件记录的行为以及真实 WKWebView 仍未人工验收。
