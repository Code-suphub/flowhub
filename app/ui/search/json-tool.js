// Format token whitespace only: preserve number precision, key order and escapes.
(() => {
  const MAX_INPUT = 65536;
  let cachedQuery = null, cached = null;
  function format(query) {
    if (query.length > MAX_INPUT) return null;
    const text = query.trim();
    if (!/^[{[]/.test(text)) return null;
    try { JSON.parse(text); } catch { return null; }
    const tokens = text.match(/"(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]/g);
    let depth = 0, pretty = '';
    const newline = () => '\n' + '  '.repeat(depth);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i], previous = tokens[i-1], next = tokens[i+1];
      if (token === '{' || token === '[') {
        if (++depth > 64) return null;
        pretty += token;
        if (next !== '}' && next !== ']') pretty += newline();
      } else if (token === '}' || token === ']') {
        depth--;
        if (previous !== '{' && previous !== '[') pretty += newline();
        pretty += token;
      } else if (token === ',') pretty += ',' + newline();
      else if (token === ':') pretty += ': ';
      else pretty += token;
    }
    return { pretty, compact: tokens.join('') };
  }
  function get(query) {
    if (query !== cachedQuery) { cachedQuery = query; cached = format(query); }
    return cached;
  }
  const button = (action, label) => `<button type="button" class="tool-action" data-tool-id="json" data-tool-action="${action}">${label}</button>`;
  async function copy(ctx, compact = false) {
    const value = get(ctx.queryNow()); if (!value) return;
    await ctx.copy(compact ? value.compact : value.pretty);
    ctx.status(compact ? '压缩 JSON 已复制' : '格式化 JSON 已复制');
  }
  window.FlowHubJson = { format };
  window.FlowHubTools.register({
    id: 'json',
    queryChanged({active}) { if (!active) { cachedQuery = null; cached = null; } },
    suggestions(ctx) { return get(ctx.query) ? [{ id: 'json:format', type: 'json', toolId: 'json' }] : []; },
    render(item, {esc,index,active}) {
      if (!cached) return '';
      const lines = cached.pretty.split('\n');
      const preview = lines.slice(0,40).join('\n').slice(0,6000);
      const truncated = preview.length < cached.pretty.length;
      return `<div class="result port-result ${active?'active':''}" data-i="${index}"><div class="r-body"><div class="r-title">JSON 格式化</div><div class="port-detail">2 空格缩进 · 本地处理 · 回车复制</div><pre class="network-output">${esc(preview)}</pre>${truncated?'<div class="port-detail">预览已截断，复制包含完整 JSON。</div>':''}<div class="tool-actions">${button('pretty','复制格式化 JSON')}${button('compact','复制压缩 JSON')}</div></div></div>`;
    },
    choose(item,ctx) { return copy(ctx); },
    action(action,target,ctx) { if (action === 'pretty' || action === 'compact') return copy(ctx,action === 'compact'); }
  });
})();
