// 命令历史与参数模板：把执行过的 ping／curl／port 查询留在本地，方便重新执行、复制实际命令。
//
// 只保存查询串与参数，条数有上限（每工具 20 条历史、10 个模板，历史总量 100 条）。
// 带凭据、密钥或口令的查询不写入：URL 里的 user:password、常见密钥类查询参数、
// curl 的 -u/--user/--password 以及 Authorization 头都算敏感内容。
(() => {
  const HISTORY_KEY = 'flowhub:command-history:v1';
  const TEMPLATE_KEY = 'flowhub:command-templates:v1';
  const HISTORY_PER_TOOL = 20;
  const HISTORY_TOTAL = 100;
  const TEMPLATE_PER_TOOL = 10;
  const SENSITIVE = [
    /:\/\/[^\s/@]+:[^\s/@]*@/,                                                          // URL 里的 user:password
    /[?&](?:token|access_token|api[_-]?key|apikey|key|secret|password|passwd|pwd|auth|authorization|signature|sig|session|cookie)=/i,
    /(?:^|\s)(?:-u|--user|--password|--token|--api-key)\b/i,
    /(?:^|\s)-H\s+['"]?authorization\s*:/i,
    /(?:^|\s)(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/i
  ];

  const isSensitive = query => SENSITIVE.some(pattern => pattern.test(String(query ?? '')));

  // 稳定的短 id：同一工具的同一查询总是同一个 id，重复执行只更新时间。
  const hash = text => {
    let value = 5381;
    for (let index = 0; index < text.length; index += 1) value = ((value << 5) + value + text.charCodeAt(index)) >>> 0;
    return value.toString(36);
  };
  const entryId = (toolId, query) => `${toolId}:${hash(`${toolId}|${query}`)}`;

  const storage = () => {
    try { return window.localStorage || null; } catch { return null; }
  };
  const read = key => {
    try {
      const parsed = JSON.parse(storage()?.getItem(key) || '[]');
      return Array.isArray(parsed) ? parsed.filter(entry => entry && typeof entry === 'object'
        && typeof entry.toolId === 'string' && typeof entry.query === 'string') : [];
    } catch { return []; }
  };
  const write = (key, list) => {
    try { storage()?.setItem(key, JSON.stringify(list)); return true; } catch { return false; }
  };

  const newestFirst = list => [...list].sort((left, right) => (Number(right.at) || 0) - (Number(left.at) || 0));
  // 先按每工具条数裁剪，再按总量裁剪：条数上限内最近的先留下。
  const cap = (list, perTool, total = Infinity) => {
    const used = new Map();
    const kept = [];
    for (const entry of newestFirst(list)) {
      const count = used.get(entry.toolId) || 0;
      if (count >= perTool) continue;
      used.set(entry.toolId, count + 1);
      kept.push(entry);
      if (kept.length >= total) break;
    }
    return kept;
  };
  const normalizeParams = params => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
    const result = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value) result[key] = value;
    }
    return result;
  };
  const push = (key, perTool, entry) => {
    const list = read(key).filter(item => item.id !== entry.id);
    list.unshift(entry);
    const kept = cap(list, perTool, key === HISTORY_KEY ? HISTORY_TOTAL : Infinity);
    write(key, kept);
    return kept;
  };

  const history = {
    list(toolId) { return newestFirst(read(HISTORY_KEY).filter(entry => !toolId || entry.toolId === toolId)); },
    // 已执行命令才记录；敏感内容、空查询直接跳过并回报原因。
    record(toolId, query, { at = Date.now(), params } = {}) {
      const text = String(query ?? '').trim();
      if (!toolId || !text) return { recorded: false, reason: 'empty' };
      if (isSensitive(text)) return { recorded: false, reason: 'sensitive' };
      const entry = { id: entryId(toolId, text), toolId, query: text, params: normalizeParams(params), at };
      const kept = push(HISTORY_KEY, HISTORY_PER_TOOL, entry);
      return { recorded: true, id: entry.id, kept: kept.filter(item => item.toolId === toolId).length };
    },
    forget(toolId, id) { write(HISTORY_KEY, read(HISTORY_KEY).filter(entry => !(entry.toolId === toolId && entry.id === id))); },
    clear(toolId) { write(HISTORY_KEY, toolId ? read(HISTORY_KEY).filter(entry => entry.toolId !== toolId) : []); }
  };

  const templates = {
    list(toolId) { return newestFirst(read(TEMPLATE_KEY).filter(entry => !toolId || entry.toolId === toolId)); },
    // 模板存的是参数化的查询：参数由工具自己校验过，这里只做形状与敏感内容检查。
    save(toolId, { query, params, at = Date.now() } = {}) {
      const text = String(query ?? '').trim();
      if (!toolId || !text) return { saved: false, reason: 'empty' };
      if (isSensitive(text)) return { saved: false, reason: 'sensitive' };
      const entry = { id: entryId(toolId, text), toolId, query: text, params: normalizeParams(params), at };
      const kept = push(TEMPLATE_KEY, TEMPLATE_PER_TOOL, entry);
      return { saved: true, id: entry.id, kept: kept.filter(item => item.toolId === toolId).length };
    },
    forget(toolId, id) { write(TEMPLATE_KEY, read(TEMPLATE_KEY).filter(entry => !(entry.toolId === toolId && entry.id === id))); },
    clear(toolId) { write(TEMPLATE_KEY, toolId ? read(TEMPLATE_KEY).filter(entry => entry.toolId !== toolId) : []); }
  };

  const counts = () => {
    const stored = read(HISTORY_KEY);
    const byTool = {};
    // 按工具名排序，汇总文案与测试都不依赖记录的先后顺序。
    for (const entry of [...stored].sort((left, right) => left.toolId.localeCompare(right.toolId))) {
      byTool[entry.toolId] = (byTool[entry.toolId] || 0) + 1;
    }
    return { total: stored.length, templates: read(TEMPLATE_KEY).length, byTool };
  };
  const clearAll = () => { write(HISTORY_KEY, []); write(TEMPLATE_KEY, []); };

  function formatAge(at, now = Date.now()) {
    const elapsed = Math.max(0, now - (Number(at) || 0));
    if (elapsed < 60_000) return '刚刚';
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
    const date = new Date(Number(at) || 0);
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  const paramText = params => Object.entries(params || {}).map(([key, value]) => `${key}=${value}`).join(' ');

  function rowsHtml(toolId, entries, actions, esc) {
    return entries.map(entry => `<li>
        <span class="command-query"><code>${esc(entry.query)}</code><small>${esc([formatAge(entry.at), paramText(entry.params)].filter(Boolean).join(' · '))}</small></span>
        <span class="command-actions">${actions.map(([action, text]) => `<button type="button" class="tool-action" data-tool-id="${esc(toolId)}" data-tool-action="${action}" data-command-id="${esc(entry.id)}">${text}</button>`).join('')}</span>
      </li>`).join('');
  }

  // 工具结果里的共享面板：最近执行（可重新执行／复制实际命令／移除／清空）与参数模板。
  function panelHtml(toolId, esc) {
    const recent = history.list(toolId);
    const saved = templates.list(toolId);
    const historySection = recent.length ? `<div class="command-panel">
      <div class="command-panel-head"><span>最近执行</span><button type="button" class="tool-action" data-tool-id="${esc(toolId)}" data-tool-action="history-clear">清空历史</button></div>
      <ul class="command-list">${rowsHtml(toolId, recent, [['history-run', '重新执行'], ['history-copy', '复制实际命令'], ['history-forget', '移除']], esc)}</ul>
    </div>` : '';
    const templateSection = `<div class="command-panel">
      <div class="command-panel-head"><span>参数模板</span><button type="button" class="tool-action" data-tool-id="${esc(toolId)}" data-tool-action="template-save">把当前查询存为模板</button></div>
      ${saved.length ? `<ul class="command-list">${rowsHtml(toolId, saved, [['template-run', '填入并执行'], ['template-copy', '复制实际命令'], ['template-forget', '删除']], esc)}</ul>`
        : '<div class="port-detail">还没有模板：把常用的主机、端口或 URL 存下来，下次直接填入执行。</div>'}
    </div>`;
    return `${historySection}${templateSection}`;
  }

  window.FlowHubCommandStore = {
    HISTORY_PER_TOOL, HISTORY_TOTAL, TEMPLATE_PER_TOOL,
    isSensitive, history, templates, counts, clearAll, formatAge, panelHtml
  };
})();
