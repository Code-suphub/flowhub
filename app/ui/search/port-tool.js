(() => {
  const parse = query => {
    const match = /^(?:port|端口)\s+(\d{1,5})$/i.exec(String(query).trim());
    const port = match ? Number(match[1]) : 0;
    return port >= 1 && port <= 65535 ? port : null;
  };
  const commands = port => ({
    macos: `# macOS: TCP listeners and UDP bindings\nPORT=${port}\nlsof -nP -iTCP:$PORT -sTCP:LISTEN\nlsof -nP -iUDP:$PORT | awk -v p="$PORT" 'NR==1 || $9 ~ (":" p "($|->)")'\npids=$( { lsof -nP -t -iTCP:$PORT -sTCP:LISTEN; lsof -nP -iUDP:$PORT | awk -v p="$PORT" 'NR>1 && $9 ~ (":" p "($|->)") {print $2}'; } | sort -u | paste -sd, - )\n[ -z "$pids" ] || ps -p "$pids" -o pid=,user=,lstart=,etime=,comm=`,
    linux: `# Linux: run on the target host; sudo may require authorization\nPORT=${port}\nsudo ss -H -ltnp "sport = :$PORT"\nsudo ss -H -uanp "sport = :$PORT"\npids=$( { sudo ss -H -ltnp "sport = :$PORT"; sudo ss -H -uanp "sport = :$PORT"; } | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | paste -sd, - )\n[ -z "$pids" ] || ps -p "$pids" -o pid=,user=,lstart=,etime=,comm=`
  });
  const formatElapsed = value => {
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(value || '').trim());
    if (!match) return value || '—';
    const [, days, hours, minutes, seconds] = match;
    return [[days,'天'],[hours,'小时'],[minutes,'分'],[seconds,'秒']]
      .filter(([number]) => Number(number) > 0).map(([number,unit]) => `${Number(number)} ${unit}`).join(' ') || '0 秒';
  };
  const formatStartedAt = value => {
    const match = /^\w+\s+(\w+)\s+(\d+)\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})$/.exec(String(value || '').trim());
    const month = match && ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[1]) + 1;
    return month ? `${match[4]}-${String(month).padStart(2,'0')}-${match[2].padStart(2,'0')} ${match[3]}` : value || '—';
  };
  window.FlowHubPortCommands = {parse, commands, formatElapsed, formatStartedAt};
  const store = () => window.FlowHubCommandStore || null;
  const toolParams = port => ({port: String(port)});
  let current = {port:null, processes:[], status:'idle'}, timer, token=0, confirming=null, terminating=false;
  const pendingInspections = new Map();
  function inspectOnce(port, api) {
    if (!pendingInspections.has(port)) {
      const request = Promise.resolve().then(() => api.inspectPort(port)).finally(() => pendingInspections.delete(port));
      pendingInspections.set(port, request);
    }
    return pendingInspections.get(port);
  }
  // 历史只记用户明确发起的查询（回车或刷新）：自动预览会在输入过程中反复触发，
  // 记下来只会得到一堆半截端口号。
  function remember(port, ctx) {
    if (!store() || ctx?.enabled?.('commandHistory') === false) return;
    store().history.record('port', `port ${port}`, { params: toolParams(port) });
  }
  async function refresh(port, ctx, { explicit = false } = {}) {
    const version=++token; confirming=null;
    current={port,processes:[],status:'loading'}; ctx.render();
    try {
      if (!ctx.api?.inspectPort) throw new Error('浏览器预览不读取本机进程；可复制查询命令。');
      const report=await inspectOnce(port, ctx.api);
      if(version!==token) return;
      current={...report,status:'ready'};
      if (explicit) remember(port, ctx);
    } catch(error) { if(version===token) current={port,processes:[],status:'error',error:error.message||String(error)}; }
    if(version===token && parse(ctx.queryNow())===port) ctx.render();
  }

  window.FlowHubTools.register({
    id:'port',
    queryChanged(ctx) {
      clearTimeout(timer); token++; confirming=null;
      const port=ctx.active?parse(ctx.query):null;
      if (!port) {current={port:null,processes:[],status:'idle'};return;}
      current={port,processes:[],status:'loading'};
      timer=setTimeout(()=>refresh(port,ctx),180);
    },
    suggestions(ctx) {const port=parse(ctx.query);return port?[{id:`port:${port}`,toolId:'port',type:'port',port,confirming,terminating,title:`端口 ${port}`,details:current.port===port?current:{status:'idle',processes:[]}}]:[];},

    choose(item,ctx) {remember(item.port,ctx);return ctx.copy(JSON.stringify({port:item.port,...item.details},(key,value)=>key==='identity'?undefined:value,2)).then(()=>ctx.status('端口详情已复制'));},
    async action(action,target,ctx) {
      const commandId = target?.dataset?.commandId;
      const entry = store() && commandId
        ? store().history.list('port').concat(store().templates.list('port')).find(item=>item.id===commandId)
        : null;
      if(action==='history-clear') {store().history.clear('port');ctx.render();return ctx.status?.('已清空本工具的历史');}
      if(action==='template-save') {
        const value=parse(ctx.queryNow());if(!value)return ctx.status?.('先输入 1-65535 的端口再存为模板');
        const saved=store().templates.save('port',{query:`port ${value}`,params:toolParams(value)});
        if(!saved.saved)return ctx.status?.('没有可保存的查询');
        ctx.render();return ctx.status?.('已存为参数模板');
      }
      if(action==='history-forget') {store().history.forget('port',entry?.id);ctx.render();return;}
      if(action==='template-forget') {store().templates.forget('port',entry?.id);ctx.render();return;}
      // 复用输入框那条路径：填入后由 180ms 防抖触发真正的查询，避免重复检查同一个端口。
      if(action==='history-run'||action==='template-run') {
        const port=entry&&parse(entry.query);
        if(!port)return ctx.status?.('这条记录的端口已不可用，请重新输入');
        ctx.setQuery?.(entry.query);return ctx.status?.(`已填入端口 ${port}`);
      }
      if(action==='history-copy'||action==='template-copy') {
        const port=entry&&parse(entry.query);
        if(!port)return ctx.status?.('这条记录已不可用');
        await ctx.copy(commands(port).macos);return ctx.status?.('macOS 查询命令已复制');
      }
      const port=parse(ctx.queryNow()); if (!port) return;
      if(action==='copy-process' || action==='copy-path') {
        const process=current.processes?.find(p=>p.pid===Number(target.dataset.pid));
        if(!process) return;
        const text=action==='copy-path'?process.executable:[
          `进程: ${process.name}`, `PID: ${process.pid}`, `用户: ${process.user}`,
          `监听 / 绑定: ${process.sockets.join(', ')}`,
          `启动时间（本机时区）: ${formatStartedAt(process.startedAt)}`,
          `已运行: ${formatElapsed(process.elapsed)}`, `路径 / 命令: ${process.executable}`
        ].join('\n');
        await ctx.copy(text);ctx.status(action==='copy-path'?'路径 / 命令已复制':'进程详情已复制');return;
      }
      if(action.startsWith('copy-')) {await ctx.copy(commands(port)[action==='copy-linux'?'linux':'macos']);ctx.status('查询命令已复制');return;}
      if(action==='refresh') {clearTimeout(timer);return refresh(port,ctx,{explicit:true});}
      const pid=Number(target.dataset.pid);
      if(action==='terminate') {confirming=pid;ctx.render();return;}
      if(action==='cancel') {confirming=null;ctx.render();return;}
      if(action==='confirm') {
        if(terminating) return;
        const process=current.processes?.find(p=>p.pid===pid);
        if(confirming!==pid||!process) return;
        terminating=true;confirming=null;target.disabled=true;
        try {
          const message=await ctx.api.terminatePortProcess(port,pid,process.identity);
          if(parse(ctx.queryNow())!==port) return;
          await refresh(port,ctx);current.message=message;ctx.render();ctx.status('已发送退出信号');
        } catch(error) { if(parse(ctx.queryNow())===port) {current.message=error.message||String(error);ctx.render();} }
        finally {terminating=false;}
      }
    }
  });
})();
