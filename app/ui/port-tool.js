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
  let current = {port:null, processes:[], status:'idle'}, timer, token=0, confirming=null, terminating=false;
  async function refresh(port, ctx) {
    const version=++token; confirming=null;
    current={port,processes:[],status:'loading'}; ctx.render();
    try {
      if (!ctx.api?.inspectPort) throw new Error('浏览器预览不读取本机进程；可复制查询命令。');
      const report=await ctx.api.inspectPort(port);
      if(version!==token) return;
      current={...report,status:'ready'};
    } catch(error) { if(version===token) current={port,processes:[],status:'error',error:error.message||String(error)}; }
    if(version===token && parse(ctx.queryNow())===port) ctx.render();
  }
  const button=(action,text,extra='')=>`<button type="button" class="tool-action" data-tool-id="port" data-tool-action="${action}" ${extra}>${text}</button>`;
  window.FlowHubTools.register({
    id:'port',
    queryChanged(ctx) {
      clearTimeout(timer); token++; confirming=null;
      const port=ctx.active?parse(ctx.query):null;
      if (!port) {current={port:null,processes:[],status:'idle'};return;}
      current={port,processes:[],status:'loading'};
      timer=setTimeout(()=>refresh(port,ctx),180);
    },
    suggestions(ctx) {const port=parse(ctx.query);return port?[{id:`port:${port}`,toolId:'port',type:'port',port,title:`端口 ${port}`,details:current.port===port?current:{status:'idle',processes:[]}}]:[];},
    render(item,{esc,index,active}) {
      const details=item.details;
      const rows=(details.processes||[]).map(p => {
        const fields = [
          ['进程', p.name], ['PID', String(p.pid)], ['用户', p.user],
          ['监听 / 绑定', p.sockets.join('\n')],
          ['启动时间', formatStartedAt(p.startedAt)], ['已运行', formatElapsed(p.elapsed)],
          ['路径 / 命令', p.executable]
        ];
        return `<section class="port-process" aria-label="${esc(p.name)}，PID ${p.pid}">
          <table class="process-properties"><caption>进程详情 · PID ${p.pid}</caption><tbody>${fields.map(([label,value]) => `<tr><th scope="row">${label}${label==='启动时间'?'<small>本机时区</small>':''}</th><td>${esc(value || '—')}</td></tr>`).join('')}</tbody></table>
          <div class="process-actions">${button('copy-process','复制详情',`data-pid="${p.pid}"`)}${button('copy-path','复制路径 / 命令',`data-pid="${p.pid}"`)}${confirming===p.pid?'':button('terminate','结束进程',`data-pid="${p.pid}"`)}</div>
          ${confirming===p.pid?`<div class="port-confirm">确认向 ${esc(p.name)}（PID ${p.pid}）发送 SIGTERM？${button('confirm','确认结束',`data-pid="${p.pid}"`)}${button('cancel','取消')}</div>`:''}
        </section>`;
      }).join('');
      const status=['idle','loading'].includes(details.status)?'正在检查本机端口…':details.error||(details.processes?.length?`${details.processes.length} 个可见进程`:'查询完成 · 未发现可见的监听/绑定进程');
      return `<div class="result port-result ${active?'active':''}" data-i="${index}"><div class="r-body"><div class="r-title">端口 ${item.port} <span class="r-kind">TCP / UDP</span></div><div class="port-detail" role="status">${esc(status)}</div>${rows}<div class="port-detail">${esc(details.message||details.visibility||'查询本机 TCP 监听、UDP 绑定；其他用户进程可能不可见。')}</div><div class="tool-actions">${button('refresh','刷新')}${button('copy-macos','复制 macOS 查询命令')}${button('copy-linux','复制 Linux 查询命令')}</div><div class="port-detail">回车复制详情 · F6 聚焦操作按钮；结束进程仅作用于本机。</div></div></div>`;
    },
    choose(item,ctx) {return ctx.copy(JSON.stringify({port:item.port,...item.details},(key,value)=>key==='identity'?undefined:value,2)).then(()=>ctx.status('端口详情已复制'));},
    async action(action,target,ctx) {
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
      if(action==='refresh') {clearTimeout(timer);return refresh(port,ctx);}
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
