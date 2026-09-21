import { Button } from '../shared/ui';
import { host, type SearchItem, type SearchSnapshot, type Data } from './types';

export function ToolButton({item, action, children, disabled, pid, part, commandId}: {
  item: SearchItem; action: string; children: React.ReactNode; disabled?:boolean; pid?:number; part?:number; commandId?:string;
}) {
  return <Button className="tool-action" data-tool-id={item.toolId} data-tool-action={action} data-pid={pid} data-part={part} data-command-id={commandId} disabled={disabled}>{children}</Button>;
}
function Properties({rows}: {rows: [string, React.ReactNode][]}) {
  return <table className="search-properties"><tbody>{rows.map(([label,value],i)=><tr key={i}><th scope="row">{label}</th><td>{value || '—'}</td></tr>)}</tbody></table>;
}
function History({item,snapshot}: {item:SearchItem;snapshot:SearchSnapshot}) {
  const store = host.FlowHubCommandStore;
  if (!store || document.documentElement.dataset.weborgReadonly === 'true' || snapshot.state.config?.plugins?.tools?.settings?.commandHistory === false) return null;
  return <div className="grid gap-3 mt-3">{(['history','templates'] as const).map(kind=>{
    const entries: Data[] = store[kind].list(item.toolId);
    const prefix = kind==='history'?'history':'template';
    return <section key={kind}><div className="flex flex-wrap items-center justify-between gap-2"><strong>{kind==='history'?'最近执行':'参数模板'}</strong><ToolButton item={item} action={kind==='history'?'history-clear':'template-save'}>{kind==='history'?'清空历史':'把当前查询存为模板'}</ToolButton></div>
      {entries.map(entry=><div className="search-history flex flex-wrap items-center gap-2" key={entry.id}><code className="flex-1 min-w-0 break-all">{entry.query}</code><small>{store.formatAge(entry.at)}</small>{[['run','填入并执行'],['copy','复制实际命令'],['forget','移除']].map(([action,label])=><ToolButton key={action} item={item} action={`${prefix}-${action}`} commandId={entry.id}>{label}</ToolButton>)}</div>)}
    </section>;
  })}</div>;
}
export function ToolContent({item,snapshot}: {item:SearchItem;snapshot:SearchSnapshot}) {
  const d=item.details;
  if(item.type==='json') {
    const full=String(item.formatted?.pretty || ''), preview=full.split('\n').slice(0,40).join('\n').slice(0,6000);
    return <><h3>JSON 格式化</h3><p className="search-meta">2 空格缩进 · 本地处理 · 回车复制</p><pre>{preview}</pre>{preview.length<full.length?<p>预览已截断，复制包含完整 JSON。</p>:null}<div className="search-actions"><ToolButton item={item} action="pretty">复制格式化 JSON</ToolButton><ToolButton item={item} action="compact">复制压缩 JSON</ToolButton></div></>;
  }
  if(item.type==='url-tool') {
    const v=item.parsed;
    return <><h3>{v.mode==='url'?'URL 解析':v.encoding?'URL 组件编码':'URL 组件解码'}</h3><p className="search-meta">本地处理 · 不发起网络请求 · 回车复制</p>{v.error?<p role="status">{v.error}</p>:v.mode==='codec'?<><pre>{v.value.slice(0,4000)}</pre>{v.value.length>4000?<p>预览已截断，复制包含完整内容。</p>:null}<ToolButton item={item} action="copy">复制结果</ToolButton></>:<><Properties rows={v.rows.slice(0,20).map(([label,value]:string[],i:number)=>[label.slice(0,100),<span key={i}>{value.slice(0,500)}{value.length>500?'…':''} <ToolButton item={item} action="value" part={i}>复制</ToolButton></span>])}/>{v.rows.length>20?<p>仅预览前 20 项，复制详情包含全部参数。</p>:null}<ToolButton item={item} action="copy">复制解析详情</ToolButton></>}</>;
  }
  if(item.type==='port') return <><h3>端口 {item.port} <small>TCP / UDP</small></h3><p role="status">{['idle','loading'].includes(d.status)?'正在检查本机端口…':d.error || `${d.processes?.length || 0} 个可见进程`}</p>{(d.processes||[]).map((p:Data)=><section key={p.pid} aria-label={`${p.name}，PID ${p.pid}`} className="search-process">
    <Properties rows={[
      ['进程',p.name],['PID',p.pid],['用户',p.user],['监听 / 绑定',(p.sockets||[]).join('\n')],
      ['启动时间（本机时区）',host.FlowHubPortCommands.formatStartedAt(p.startedAt)],['已运行',host.FlowHubPortCommands.formatElapsed(p.elapsed)],['路径 / 命令',p.executable]
    ]}/><div className="search-actions"><ToolButton item={item} action="copy-process" pid={p.pid}>复制详情</ToolButton><ToolButton item={item} action="copy-path" pid={p.pid}>复制路径 / 命令</ToolButton>{item.confirming!==p.pid?<ToolButton item={item} action="terminate" pid={p.pid}>结束进程</ToolButton>:null}</div>
    {item.confirming===p.pid?<div role="alert" className="search-confirm">确认向 {p.name}（PID {p.pid}）发送 SIGTERM？<ToolButton item={item} action="confirm" pid={p.pid} disabled={item.terminating}>确认结束</ToolButton><ToolButton item={item} action="cancel">取消</ToolButton></div>:null}
  </section>)}<p className="search-meta">{d.message || d.visibility || '查询本机 TCP 监听、UDP 绑定；其他用户进程可能不可见。'}</p><div className="search-actions">{[['refresh','刷新'],['copy-macos','复制 macOS 查询命令'],['copy-linux','复制 Linux 查询命令']].map(([a,label])=><ToolButton key={a} item={item} action={a}>{label}</ToolButton>)}</div><History item={item} snapshot={snapshot}/></>;
  if(item.type==='network') {
    const report=item.report, ipv6=item.toolId==='ping' && item.q.target.includes(':');
    return <><h3>{item.toolId==='ping'?'Ping 连通性':item.q.head?'HTTP 响应头':'HTTP GET 请求'}</h3><p className="search-meta">{item.q.target}</p><p role="status">{item.busy?'正在执行…':item.error || (report?`${report.timedOut?'执行超时':report.exitCode===0?'执行完成':'命令未成功'} · ${report.elapsedMs} ms · 退出码 ${report.exitCode??'—'}`:'回车或点击执行')}</p>{report?<pre>{report.output || '没有输出'}{report.truncated?'\n…输出已截断':''}</pre>:null}<div className="search-actions"><ToolButton item={item} action="run" disabled={item.busy}>{report?'重新执行':'执行'}</ToolButton><ToolButton item={item} action="command">{ipv6?'复制 macOS 命令':'复制查询命令'}</ToolButton>{ipv6?<ToolButton item={item} action="linux">复制 Linux 命令</ToolButton>:null}{report?<ToolButton item={item} action="output">复制输出</ToolButton>:null}</div><p className="search-meta">{item.toolId==='ping'?'发送 4 次探测，最多等待 8 秒。无回复不一定表示主机离线。':'支持 GET / HEAD，不自动跟随重定向；最多等待 12 秒。'}</p><History item={item} snapshot={snapshot}/></>;
  }
  if(item.type==='public-ip') return <><h3>公网 IP · 当前网络出口</h3>{['ipv4','ipv6'].map(f=><div className="flex flex-wrap gap-2 items-center my-2" key={f}><strong>{f.toUpperCase()}</strong><span>{d?.[f] || (!d || d.pending?.includes(f)?'正在查询…':d.error || d.errors?.[f] || '未获取到地址')}</span>{d?.[f]?<ToolButton item={item} action={`copy-${f}`}>复制地址</ToolButton>:null}</div>)}<p className="search-meta">显示查询服务看到的出口地址；使用代理时可能是代理出口。</p><div className="search-actions"><ToolButton item={item} action="refresh">刷新</ToolButton><ToolButton item={item} action="command">复制查询命令</ToolButton></div></>;
  if(item.type==='ip') return <><h3>{item.result}</h3>{d?.private?<p>私有地址 · 无公网归属地</p>:d?.error?<p>查询失败 · 请检查网络</p>:d?<Properties rows={[
    ['位置',[d.city,d.region,d.country_name].filter(Boolean).join(' · ')],['组织',d.org],['ASN',d.asn],['时区',d.timezone]
  ]}/>:<p>正在查询 IP 归属地…</p>}</>;
  if(item.type==='dns') return <><h3>DNS · {item.hostname} · {item.family}</h3>{item.answers?.length?<Properties rows={item.answers.slice(0,8).map((a:Data)=>{
    const geo=snapshot.state.config?.plugins?.tools?.settings?.dnsIpGeo!==false?snapshot.state.dnsIpResults[a.data]:null;
    return [String(a.type===1?'A':a.type===28?'AAAA':'CNAME'),<span>{a.data}{geo?<small className="block">{geo.error?'归属地查询失败':[geo.city,geo.region,geo.country_name].filter(Boolean).join(' · ')}</small>:null}</span>];
  })}/>:<p>{snapshot.state.dnsResult?.hostname===item.hostname?'无 DNS 记录':'正在查询 DNS…'}</p>}<p className="search-meta">{item.answers?.length>8?`还有 ${item.answers.length-8} 条记录 · `:''}回车复制完整记录</p></>;
  if(item.type==='cloudflare') return <><h3>Cloudflare · {item.hostname}</h3><p>{d?.challenge?'检测到 Cloudflare 挑战或拦截':d?.cloudflare?`检测到 Cloudflare · HTTP ${d.status || '?'}`:d?`未发现 Cloudflare 特征 · HTTP ${d.status || '?'}`:item.cnameEvidence?.length?'DNS 记录疑似经过 Cloudflare · 回车确认':'回车检测 Cloudflare 与拦截状态'}</p><p className="search-meta">{d?.evidence?.join('、') || item.cnameEvidence?.join('、') || (d?'未发现响应头特征':'不会自动发起 HTTP 请求')}</p></>;
  if(item.type==='proxy') return <><h3>代理信息</h3>{d?.error?<p>{d.error}</p>:d?<Properties rows={[...['http','https','socks'].map(k=>[k.toUpperCase(),d[k]?.enabled && d[k]?.host?`${d[k].host}:${d[k].port || ''}`:'未启用'] as [string,string]),['出口 IP',d.egressIp],['当前节点',d.node?.remoteAddress?`${d.node.nodeName || '当前连接'} · ${d.node.remoteAddress}`:'—']]}/>:<p>正在读取系统代理…</p>}</>;
  return <><h3>{item.type==='jwt'?'JWT 解析':item.result}</h3><p className="search-meta">{item.type==='jwt'?`${item.payload?.sub || item.payload?.iss || 'header + payload'} · 回车复制 JSON`:`${item.type==='timestamp'?'时间戳':'计算'} · ${item.expression}${item.unit?`（${item.unit}）`:''}`}</p></>;
}
