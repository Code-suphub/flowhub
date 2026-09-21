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
  const params = q => q.kind==='curl'?{url:q.target,method:q.head?'HEAD':'GET'}:{host:q.target};
  const store = () => window.FlowHubCommandStore || null;
  window.FlowHubNetworkTools = {parse,command};
  for(const kind of ['ping','curl']) {
    let version=0,report=null,error='',busy=false;

    // 历史与模板只在桌面版开关打开时读写；测试或预览里没有这个模块就整体跳过。
    const historyEnabled = ctx => Boolean(store()) && ctx?.enabled?.('commandHistory') !== false;

    const remember = (ctx,q) => {
      if(!historyEnabled(ctx))return;
      const saved=store().history.record(kind,ctx.queryNow(),{params:params(q)});
      if(saved.reason==='sensitive')ctx.status?.('这条命令带凭据或密钥，没有写入历史');
    };
    const entry = (target) => store()?.history.list(kind).concat(store().templates.list(kind))
      .find(item => item.id === target?.dataset?.commandId) || null;
    async function run(ctx) {
      const q=parse(ctx.queryNow());if(!q||q.kind!==kind||busy)return;
      const current=version;busy=true;report=null;error='';ctx.render();
      try {
        if(!ctx.api?.runNetworkDiagnostic)throw new Error('本机执行仅在桌面版可用，可复制命令。');
        const value=await ctx.api.runNetworkDiagnostic(kind,q.target,q.head);
        if(current===version){report=value;remember(ctx,q);}
      } catch(e) {if(current===version)error=e.message||String(e);}
      finally {busy=false;ctx.render();}
    }
    // 历史／模板里的查询要重新过一遍 parse：参数非法（或已过期）的记录不会被执行。
    const replay = async (record, ctx) => {
      if(!record)return;
      const q=parse(record.query);
      if(!q||q.kind!==kind)return ctx.status?.('这条记录的参数已不可用，请重新输入');
      ctx.setQuery?.(record.query);
      return run(ctx);
    };
    window.FlowHubTools.register({
      id:kind,
      queryChanged(){++version;report=null;error='';},
      suggestions(ctx){const q=parse(ctx.query);return q?.kind===kind?[{id:`network:${kind}:${q.target}:${q.head}`,toolId:kind,type:'network',q,report,error,busy}]:[];},

      choose(item,ctx){return run(ctx);},
      async action(action,target,ctx) {
        if(action==='history-clear'){store().history.clear(kind);ctx.render();return ctx.status?.('已清空本工具的历史');}
        if(action==='template-save'){
          const q=parse(ctx.queryNow());if(!q||q.kind!==kind)return ctx.status?.('先输入可识别的查询再存为模板');
          const saved=store().templates.save(kind,{query:ctx.queryNow(),params:params(q)});
          if(!saved.saved)return ctx.status?.(saved.reason==='sensitive'?'这条命令带凭据或密钥，没有存为模板':'没有可保存的查询');
          ctx.render();return ctx.status?.('已存为参数模板');
        }
        const record=entry(target);
        if(action==='history-forget'){store().history.forget(kind,record?.id);ctx.render();return;}
        if(action==='template-forget'){store().templates.forget(kind,record?.id);ctx.render();return;}
        if(action==='history-run'||action==='template-run')return replay(record,ctx);
        if(action==='history-copy'||action==='template-copy'){
          const q=record&&parse(record.query);
          if(!q||q.kind!==kind)return ctx.status?.('这条记录已不可用');
          await ctx.copy(command(q));return ctx.status?.('实际命令已复制');
        }
        const q=parse(ctx.queryNow());if(!q||q.kind!==kind)return;
        if(action==='run')return run(ctx);
        if(action==='output'&&report){await ctx.copy(report.output);ctx.status('输出已复制');}
        if(action==='command'||action==='linux'){await ctx.copy(command(q,action==='linux'));ctx.status('查询命令已复制');}
      }
    });
  }
})();
