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

  async function copy(ctx, compact = false) {
    const value = get(ctx.queryNow()); if (!value) return;
    await ctx.copy(compact ? value.compact : value.pretty);
    ctx.status(compact ? '压缩 JSON 已复制' : '格式化 JSON 已复制');
  }
  window.FlowHubJson = { format };
  window.FlowHubTools.register({
    id: 'json',
    queryChanged({active}) { if (!active) { cachedQuery = null; cached = null; } },
    suggestions(ctx) { return get(ctx.query) ? [{ id: 'json:format', type: 'json', toolId: 'json', formatted: get(ctx.query) }] : []; },

    choose(item,ctx) { return copy(ctx); },
    action(action,target,ctx) { if (action === 'pretty' || action === 'compact') return copy(ctx,action === 'compact'); }
  });
})();
