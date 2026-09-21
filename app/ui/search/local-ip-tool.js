(() => {
  const matches = query => /^(?:ip|本机\s*ip|公网\s*ip|我的\s*ip|my\s*ip|local\s*ip)$/i.test(String(query).trim());
  let details = null, token = 0, timer, controller;

  async function refresh(ctx) {
    const version = ++token;
    controller?.abort();
    controller = new AbortController();
    details = {pending:['ipv4','ipv6'], errors:{}};
    ctx.render();
    const publish = result => { if (token === version && matches(ctx.queryNow())) { details = result; ctx.render(); } };
    try { publish(await ctx.api.lookupLocalIp(publish, {signal:controller.signal})); }
    catch (error) { publish({pending:[], error:error.message || String(error)}); }
  }
  window.FlowHubTools.register({
    id:'localIp',
    queryChanged(ctx) {
      clearTimeout(timer); ++token; controller?.abort(); details = null;
      if (ctx.active && matches(ctx.query)) timer = setTimeout(() => refresh(ctx), 180);
    },
    suggestions(ctx) { return matches(ctx.query) ? [{id:'public-ip', toolId:'localIp', type:'public-ip', details}] : []; },

    async choose(item,ctx) {
      const text = ['ipv4','ipv6'].filter(f => item.details?.[f]).map(f => `${f === 'ipv4' ? 'IPv4' : 'IPv6'}: ${item.details[f]}`).join('\n');
      if (!text) { ctx.status('尚未获取到地址'); return; }
      await ctx.copy(text); ctx.status('公网 IP 已复制');
    },
    async action(action,target,ctx) {
      if (!matches(ctx.queryNow())) return;
      if (action === 'refresh') {clearTimeout(timer); return refresh(ctx);}
      if (action === 'command') {
        await ctx.copy('# 查询执行机器的公网出口 IP（macOS / Linux）\nprintf "IPv4: "\ncurl -4 --fail --connect-timeout 3 --max-time 6 https://api4.ipify.org\nprintf "\\nIPv6: "\ncurl -6 --fail --connect-timeout 3 --max-time 6 https://api6.ipify.org\nprintf "\\n"');
        ctx.status('查询命令已复制');
      } else if (action.startsWith('copy-') && details?.[action.slice(5)]) {
        await ctx.copy(details[action.slice(5)]); ctx.status('地址已复制');
      }
    }
  });
})();
