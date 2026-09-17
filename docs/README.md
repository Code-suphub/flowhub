# FlowHub 文档

| 目录 | 内容 |
| --- | --- |
| [`architecture/`](./architecture) | 当前生效的架构、协议与工具行为说明，按主题分组 |
| [`tasks/`](./tasks) | 进行中的改进清单与推进顺序 |

一次性排查、性能测量与版本说明不再入库：结论已经落到代码与提交信息里，需要原始数据时从 git 历史取回。

## 架构文档

**插件**（[`architecture/plugin/`](./architecture/plugin)）

- [独立插件协议](./architecture/plugin/plugin-runtime.md)
- [插件画布](./architecture/plugin/plugin-canvas.md)
- [插件状态](./architecture/plugin/plugin-status.md)

**存储与配置**（[`architecture/storage/`](./architecture/storage)）

- [存储迁移一致性](./architecture/storage/storage-migration-consistency.md)
- [打开既有存储](./architecture/storage/storage-open-existing.md)
- [选择性配置保存](./architecture/storage/selective-config-save.md)

**设置页**（[`architecture/settings/`](./architecture/settings)）

- [网页目录与备忘编辑器](./architecture/settings/web-catalog-editor.md)

**剪贴板**（[`architecture/clipboard/`](./architecture/clipboard)）

- [留存、清理与高频操作](./architecture/clipboard/retention-and-actions.md)

**菜单栏**（[`architecture/menu-bar/`](./architecture/menu-bar)）

- [菜单栏显示间距](./architecture/menu-bar/menu-bar-display-spacing.md)
- [菜单栏显隐：光标与闪现验证](./architecture/menu-bar/menu-bar-cursor-validation.md)
- [逐个图标控制：原生附属子菜单](./architecture/menu-bar/menu-bar-item-submenu.md)
- [菜单级联外观](./architecture/menu-bar/menu-cascade-appearance.md)

**启动器**（[`architecture/launcher/`](./architecture/launcher)）

- [唤出冷启动交互](./architecture/launcher/launcher-cold-interaction.md)
- [唤出验收步骤](./architecture/launcher/launcher-verification.md)
- [结果操作、焦点顺序与快捷键](./architecture/launcher/result-actions-and-shortcuts.md)

**内置工具**（[`architecture/tools/`](./architecture/tools)）

- [网络工具](./architecture/tools/network-tools.md)
- [端口工具](./architecture/tools/port-tool.md)
- [URL 工具](./architecture/tools/url-tool.md)
- [JSON 工具](./architecture/tools/json-tool.md)

**其它**

- [自动更新检查](./architecture/automatic-update-checks.md)
- [旧 Web 服务访问边界](./architecture/legacy/legacy-web-security.md)

## 放文档的规则

- 描述**当前行为**的放 `architecture/<主题>/`；新增主题时建同级目录，不要平铺回 `architecture/` 根。
- 进行中的改进清单放 `tasks/`。
- 一次性排查、压测与性能测量**不入库**：结论写进提交信息，需要长期保留的结论提炼进 `architecture/`。
- 已完成、被取代或已迁出本仓库的实现说明不再单独建文档，随对应代码一起删除。
