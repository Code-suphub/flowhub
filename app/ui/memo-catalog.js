(function initMemoCatalog(globalObject, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalObject) globalObject.FlowHubMemoCatalog = api;
})(typeof window !== "undefined" ? window : globalThis, function createMemoCatalog() {
  const defaults = [
    {
      id: "mysql-create-table",
      title: "MySQL 创建表",
      category: "编程 / 数据库 / MySQL",
      description: "包含主键、时间字段和常用 InnoDB 参数的建表示例",
      tags: ["建表", "create table", "ddl"],
      content: "CREATE TABLE `table_name` (\n  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',\n  `name` VARCHAR(128) NOT NULL DEFAULT '' COMMENT '名称',\n  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (`id`),\n  KEY `idx_name` (`name`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='表说明';"
    },
    {
      id: "mysql-add-column",
      title: "MySQL 添加字段",
      category: "编程 / 数据库 / MySQL",
      description: "在指定字段后增加新列",
      tags: ["改表", "alter table", "add column"],
      content: "ALTER TABLE `table_name`\n  ADD COLUMN `column_name` VARCHAR(128) NOT NULL DEFAULT '' COMMENT '字段说明' AFTER `id`;"
    },
    {
      id: "mysql-change-column",
      title: "MySQL 修改字段",
      category: "编程 / 数据库 / MySQL",
      description: "修改字段类型、默认值或注释",
      tags: ["改表", "alter", "modify column"],
      content: "ALTER TABLE `table_name`\n  MODIFY COLUMN `column_name` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '字段说明';"
    },
    {
      id: "mysql-add-index",
      title: "MySQL 添加索引",
      category: "编程 / 数据库 / MySQL",
      description: "创建普通联合索引",
      tags: ["索引", "index", "alter table"],
      content: "ALTER TABLE `table_name`\n  ADD INDEX `idx_field_a_field_b` (`field_a`, `field_b`);"
    },
    {
      id: "mysql-show-processlist",
      title: "MySQL 查询运行中的 SQL",
      category: "编程 / 数据库 / MySQL",
      description: "查看当前连接和正在执行的语句",
      tags: ["processlist", "慢查询", "连接"],
      content: "SHOW FULL PROCESSLIST;"
    },
    {
      id: "docker-ps",
      title: "Docker 查看容器",
      category: "编程 / 容器 / Docker",
      description: "按表格输出运行状态、端口和名称",
      tags: ["容器", "ps", "状态"],
      content: "docker ps --format 'table {{.ID}}\\t{{.Names}}\\t{{.Status}}\\t{{.Ports}}'"
    },
    {
      id: "docker-logs",
      title: "Docker 实时查看日志",
      category: "编程 / 容器 / Docker",
      description: "查看最近 200 行并持续跟踪",
      tags: ["日志", "logs", "tail", "follow"],
      content: "docker logs --tail 200 -f <container_name>"
    },
    {
      id: "docker-exec",
      title: "Docker 进入容器",
      category: "编程 / 容器 / Docker",
      description: "使用交互式 shell 进入容器",
      tags: ["exec", "shell", "bash"],
      content: "docker exec -it <container_name> /bin/sh"
    },
    {
      id: "docker-clean",
      title: "Docker 清理无用资源",
      category: "编程 / 容器 / Docker",
      description: "清理未使用的容器、网络和悬空镜像，执行前请确认",
      tags: ["清理", "prune", "磁盘"],
      content: "docker system prune"
    },
    {
      id: "bash-disk-filesystem",
      title: "Bash 查看磁盘空间",
      category: "编程 / 系统运维 / Bash",
      description: "以易读格式显示各挂载点使用率",
      tags: ["磁盘", "disk", "df", "占用"],
      content: "df -h"
    },
    {
      id: "bash-disk-directory",
      title: "Bash 查询目录占用",
      category: "编程 / 系统运维 / Bash",
      description: "按大小倒序显示当前目录下一级文件和目录",
      tags: ["磁盘", "du", "目录大小", "占用"],
      content: "du -sh ./* 2>/dev/null | sort -hr | head -n 30"
    },
    {
      id: "bash-large-files",
      title: "Bash 查找大文件",
      category: "编程 / 系统运维 / Bash",
      description: "查找当前目录下超过 500MB 的文件",
      tags: ["磁盘", "find", "大文件"],
      content: "find . -type f -size +500M -print0 | xargs -0 ls -lh | sort -k5 -hr | head -n 30"
    },
    {
      id: "bash-port-process",
      title: "Bash 查询端口占用",
      category: "编程 / 系统运维 / Bash",
      description: "查找监听指定端口的进程",
      tags: ["端口", "port", "lsof", "进程"],
      content: "lsof -nP -iTCP:<port> -sTCP:LISTEN"
    },
    {
      id: "bash-process-memory",
      title: "Bash 按内存查看进程",
      category: "编程 / 系统运维 / Bash",
      description: "显示内存占用最高的 20 个进程",
      tags: ["内存", "memory", "进程", "ps"],
      content: "ps aux | sort -nrk 4 | head -n 20"
    },
    {
      id: "git-undo-last-commit",
      title: "Git 撤销最近一次提交",
      category: "编程 / 版本控制 / Git",
      description: "保留工作区和暂存区内容",
      tags: ["撤销", "reset", "commit"],
      content: "git reset --soft HEAD~1"
    },
    {
      id: "git-clean-branches",
      title: "Git 清理已合并分支",
      category: "编程 / 版本控制 / Git",
      description: "列出已合并到当前分支的本地分支，请确认后再删除",
      tags: ["branch", "分支", "清理"],
      content: "git branch --merged"
    },
    {
      id: "k8s-pods",
      title: "Kubernetes 查看 Pod",
      category: "编程 / 云原生 / Kubernetes",
      description: "查看命名空间内 Pod 的节点、IP 和状态",
      tags: ["kubectl", "pod", "k8s"],
      content: "kubectl get pods -n <namespace> -o wide"
    },
    {
      id: "k8s-logs",
      title: "Kubernetes 实时查看日志",
      category: "编程 / 云原生 / Kubernetes",
      description: "查看 Pod 最近日志并持续跟踪",
      tags: ["kubectl", "pod", "日志", "logs"],
      content: "kubectl logs -n <namespace> <pod_name> --tail=200 -f"
    }
  ];

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const normalized = (value) => String(value || "").trim().toLowerCase();
  const termsOf = (query) => normalized(query).split(/\s+/).filter(Boolean);
  const categorySegments = (value) => String(value || "其他").split(/\s*(?:\/|›|>)\s*/).map((segment) => segment.trim()).filter(Boolean);

  function searchableText(item) {
    return [item.title, item.category, item.description, ...(item.tags || []), item.content].map(normalized).join("\n");
  }

  function scoreMemo(item, query) {
    const queryText = normalized(query);
    const terms = termsOf(query);
    if (!terms.length) return 1;
    const title = normalized(item.title);
    const category = normalized(item.category);
    const description = normalized(item.description);
    const tags = (item.tags || []).map(normalized).join(" ");
    const content = normalized(item.content);
    const all = searchableText(item);
    if (!terms.every((term) => all.includes(term))) return -1;
    let score = title === queryText ? 1200 : title.startsWith(queryText) ? 900 : 0;
    for (const term of terms) {
      if (title === term) score += 480;
      else if (title.startsWith(term)) score += 360;
      else if (title.includes(term)) score += 260;
      if (category.includes(term) || tags.includes(term)) score += 150;
      if (description.includes(term)) score += 80;
      if (content.includes(term)) score += 30;
    }
    return score;
  }

  function rankMemos(items, query = "", limit = 12) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 12));
    return (items || [])
      .map((item, index) => ({ item, index, score: scoreMemo(item, query) }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, safeLimit)
      .map(({ item }) => ({ ...clone(item), type: "memo" }));
  }

  return { defaults, cloneDefaults: () => clone(defaults), rankMemos, categorySegments };
});
