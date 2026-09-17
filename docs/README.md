# FlowHub 文档

| 目录 | 内容 |
| --- | --- |
| [`architecture/`](architecture/) | 当前生效的架构、协议与工具行为说明 |
| [`investigations/`](investigations/) | 带日期的一次性排查、压测与性能基准记录 |
| [`tasks/`](tasks/) | 进行中的改进清单与推进顺序 |
| [`releases/`](releases/) | 历史版本说明 |

## 架构文档

- [独立插件协议](architecture/plugin-runtime.md)
- [插件画布](architecture/plugin-canvas.md)
- [插件状态](architecture/plugin-status.md)
- [机器管理实现记录](architecture/machines-implementation.md)
- [旧 Web 服务访问边界](architecture/legacy-web-security.md)
- [存储迁移一致性](architecture/storage-migration-consistency.md)
- [打开既有存储](architecture/storage-open-existing.md)
- [选择性配置保存](architecture/selective-config-save.md)
- [自动更新检查](architecture/automatic-update-checks.md)
- [唤出冷启动交互](architecture/launcher-cold-interaction.md)
- [唤出验收步骤](architecture/launcher-verification.md)
- [菜单栏显示间距](architecture/menu-bar-display-spacing.md)
- [菜单栏显隐：光标与闪现验证](architecture/menu-bar-cursor-validation.md)
- [逐个图标控制：原生附属子菜单](architecture/menu-bar-item-submenu.md)
- [菜单级联外观](architecture/menu-cascade-appearance.md)
- [网络工具](architecture/network-tools.md)
- [端口工具](architecture/port-tool.md)
- [URL 工具](architecture/url-tool.md)
- [JSON 工具](architecture/json-tool.md)

新增文档按性质放入对应子目录：描述当前行为的放 `architecture/`，一次性排查或测量放 `investigations/` 并保留带日期的原始文件名。
