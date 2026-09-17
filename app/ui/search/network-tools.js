(() => {
  const parse = query => {
    const ping = /^ping\s+([a-z0-9:][a-z0-9.:-]{0,252})$/i.exec(query.trim());
    if (ping) return {kind:'ping',target:ping[1],head:false};
    const curl = /^curl\s+(-I\s+)?(https?:\/\/\S+)$/.exec(query.trim());
    if (!curl) return null;
    try {const url=new URL(curl[2]);if(url.username||url.password)return null;return {kind:'curl',target:url.href,head:!!curl[1]};}catch{return null;}
  };
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const command = (q, linux=false) => q.kind==='curl'
    ? `curl -q ${q.head?'--head':'--include'} --connect-timeout 3 --max-time 10 --max-filesize 65536 --proto '=http,https' --url ${quote(q.target)}`
    : `${q.target.includes(':')?(linux?'ping -6':'ping6'):'ping'} -n -c 4 ${quote(q.target)}`;
  window.FlowHubNetworkTools = {parse,command};
  for(const kind of ['ping','curl']) {
    let version=0,report=null,error='',busy=false;
    const button=(action,title,disabled=false)=>`<button type="button" class="tool-action" data-tool-id="${kind}" data-tool-action="${action}" ${disabled?'disabled':''}>${title}</button>`;
    async function run(ctx) {
      const q=parse(ctx.queryNow());if(!q||q.kind!==kind||busy)return;
      const current=version;busy=true;report=null;error='';ctx.render();
      try {
        if(!ctx.api?.runNetworkDiagnostic)throw new Error('本机执行仅在桌面版可用，可复制命令。');
        const value=await ctx.api.runNetworkDiagnostic(kind,q.target,q.head);
        if(current===version)report=value;
      } catch(e) {if(current===version)error=e.message||String(e);}
      finally {busy=false;ctx.render();}
    }
    window.FlowHubTools.register({
      id:kind,
      queryChanged(){++version;report=null;error='';},
      suggestions(ctx){const q=parse(ctx.query);return q?.kind===kind?[{id:`network:${kind}:${q.target}:${q.head}`,toolId:kind,type:'network',q}]:[];},
      render(item,{esc,index,active}) {
        const ipv6=kind==='ping'&&item.q.target.includes(':');
        const status=busy?'正在执行…':error||(report?`${report.timedOut?'执行超时':report.exitCode===0?'执行完成':'命令未成功'} · ${report.elapsedMs} ms · 退出码 ${report.exitCode??'—'}`:'回车或点击执行');
        return `<div class="result port-result ${active?'active':''}" data-i="${index}"><div class="r-body"><div class="r-title">${kind==='ping'?'Ping 连通性':item.q.head?'HTTP 响应头':'HTTP GET 请求'}</div><div class="port-detail">${esc(item.q.target)}</div><div class="port-detail" role="status">${esc(status)}</div>${report?`<pre class="network-output">${esc(report.output||'没有输出')}${report.truncated?'\n…输出已截断':''}</pre>`:''}<div class="tool-actions">${button('run',report?'重新执行':'执行',busy)}${button('command',ipv6?'复制 macOS 命令':'复制查询命令')}${ipv6?button('linux','复制 Linux 命令'):''}${report?button('output','复制输出'):''}</div><div class="port-detail">${kind==='ping'?'发送 4 次探测，最多等待 8 秒。无回复不一定表示主机离线。':'支持 GET / HEAD，不自动跟随重定向；最多等待 12 秒。'} · F6 聚焦按钮</div></div></div>`;
      },
      choose(item,ctx){return run(ctx);},
      async action(action,target,ctx) {
        const q=parse(ctx.queryNow());if(!q||q.kind!==kind)return;
        if(action==='run')return run(ctx);
        if(action==='output'&&report){await ctx.copy(report.output);ctx.status('输出已复制');}
        if(action==='command'||action==='linux'){await ctx.copy(command(q,action==='linux'));ctx.status('查询命令已复制');}
      }
    });
  }
})();
