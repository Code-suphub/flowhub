import { Fragment, memo } from 'react';
import { Button } from '../shared/ui';
import { ToolContent } from './Tools';
import { host, type SearchItem, type SearchSnapshot } from './types';

const tools = new Set(['calculation','timestamp','jwt','ip','dns','cloudflare','proxy','port','network','public-ip','json','url-tool']);
const imageUrl = (value: unknown) => /^(https?:\/\/|data:image\/|(?:\.\/|\/)?assets\/)/i.test(String(value || ''));
function Icon({item,snapshot}: {item:SearchItem;snapshot:SearchSnapshot}) {
  let url = item.type==='app' ? item.iconUrl || snapshot.state.appResults.find((a:SearchItem)=>a.path===item.path)?.iconUrl : item.type==='clipboard'?item.imageUrl || item.fileIconUrl:imageUrl(item.icon)?item.icon:'';
  const web = ['page','web'].includes(item.type);
  if(web && (snapshot.failedWebIcons.has(url) || (!snapshot.showUncachedWebIcons && !snapshot.loadedWebIcons.has(url)))) url='';
  return <span className="search-icon" aria-hidden="true">{url?<img src={url} {...(web?{'data-web-icon':url}:{})} loading="lazy" decoding="async" alt=""/>:item.type==='app'?'▣':item.type==='memo'?'›_':item.kind==='file'?(item.fileType==='folder'?'▱':'▤'):item.type==='clipboard'?'▤':item.type==='web-add'?'＋':!imageUrl(item.icon) && item.icon?String(item.icon):'⌁'}</span>;
}
function ResultActions({item,index}: {item:SearchItem;index:number}) {
  const actions: [string,string][]=[];
  if(['page','web','web-add','app'].includes(item.type)) {
    actions.push(['open','打开']);
    if(item.type==='app'?item.path:/^(https?:\/\/|[a-z0-9.-]+\.[a-z]{2,})/i.test(item.url || '')) actions.push(['copy',item.type==='app'?'复制路径':'复制链接']);
  }
  if(item.type==='memo') {if(item.content?.trim()) actions.push(['copy','复制命令']);actions.push(['open','粘贴']);}
  if(item.type==='twofa') actions.push(['copy','复制验证码']);
  if(['calculation','timestamp','jwt'].includes(item.type)) actions.push(['copy','复制结果']);
  if(['dns','ip'].includes(item.type)) actions.push(['copy-query','复制查询命令']);
  return actions.length?<div className="search-actions">{actions.map(([action,label])=><Button key={action} className="tool-action" data-result-action={action} data-result-index={index}>{label}</Button>)}</div>:null;
}
function ClipButton({item,action,children}: {item:SearchItem;action:string;children:React.ReactNode}) {
  return <Button className="tool-action" data-clipboard-action={action} data-clipboard-id={item.id}>{children}</Button>;
}
function Clipboard({item,snapshot}: {item:SearchItem;snapshot:SearchSnapshot}) {
  const content=String(item.content || ''), expanded=snapshot.state.expandedClipboard.has(Number(item.id));
  const expandable=item.kind==='text' && (content.length>120 || content.split('\n').length>3);
  const preview=expanded?content:content.slice(0,300).split('\n').slice(0,5).join('\n');
  if(snapshot.state.editingClipboard?.id===Number(item.id)) return <><h3>编辑文本副本</h3><p className="search-meta">保存后写入一条新记录，原记录保留</p><textarea className="clipboard-editor" data-clipboard-editor rows={5} spellCheck={false} aria-label="编辑文本副本" defaultValue={snapshot.state.editingClipboard.text} onClick={e=>e.stopPropagation()}/><div className="search-actions"><ClipButton item={item} action="edit-save">保存副本（⌘↩）</ClipButton><ClipButton item={item} action="edit-cancel">取消（Esc）</ClipButton></div></>;
  return <><div className={`clipboard-title ${expanded?'is-expanded':''}`}>{item.kind==='image'?`图片${item.sourceName?' · '+item.sourceName:''}`:item.kind==='file'?(item.fileNames||[]).join(' · ') || `${item.fileCount || 0} 个文件`:preview+(preview.length<content.length?'…':'') || '空文本'}</div>
    <div className="flex items-center gap-2"><p className="search-meta flex-1">剪切板 · {item.lastSeenAt?new Date(item.lastSeenAt).toLocaleString():''} · {item.copyCount || 1} 次 · {String(item.hash||'').slice(0,12)}{item.pinnedAt?' · ★ 已置顶':''}</p>{expandable?<Button className="clipboard-toggle" data-clipboard-toggle={item.id} aria-expanded={expanded}>{expanded?'⌃ 收起':'⌄ 展开'}</Button>:null}</div>
    <div className="search-actions"><ClipButton item={item} action="pin">{item.pinnedAt?'★ 取消置顶（⌘D）':'☆ 置顶（⌘D）'}</ClipButton>{['text','file'].includes(item.kind)?<ClipButton item={item} action="plain">纯文本粘贴（⇧↩）</ClipButton>:null}{item.kind==='text'?<ClipButton item={item} action="edit">编辑副本（⌘E）</ClipButton>:null}</div>
  </>;
}
const Row = memo(function Row({item,index,snapshot}: {item:SearchItem;index:number;snapshot:SearchSnapshot}) {
  const isTool=tools.has(item.type), usage=Boolean(item.usageSection);
  return <div id={`search-result-${index}`} role="option" aria-selected={index===snapshot.state.index} className={`result ${item.type}-result ${usage?'usage-tile':''} ${index===snapshot.state.index?'active':''}`} data-i={index}>
    {!isTool && (item.type!=='clipboard'||item.kind!=='text')?<Icon item={item} snapshot={snapshot}/>:null}
    <div className="min-w-0 flex-1">{usage?<h3 className="search-tile-title">{item.title || '未命名'}</h3>:item.type==='clipboard'?<Clipboard item={item} snapshot={snapshot}/>:isTool?<ToolContent item={item} snapshot={snapshot}/>:item.type==='memo'?<><p className="search-meta">{host.FlowHubMemoCatalog?.categorySegments(item.category || '').join(' › ') || item.category}</p><h3>{item.title || '未命名备忘'}</h3><code className="search-command">{String(item.content||'').split('\n').slice(0,2).join('\n')}</code>{item.description?<p className="search-meta">{item.description}</p>:null}</>:item.type==='twofa'?<><h3>{item.title || item.id || '2FA'}</h3><p className="search-meta">2FA 验证码{item.issuer?' · '+item.issuer:''}</p></>:item.type==='app'?<><h3>{item.title || '未命名应用'}</h3><p className="search-meta">应用 · {item.fileName} · {item.path}</p></>:item.type==='web-add'?<><h3>添加到网页配置</h3><p className="search-meta">未找到匹配网页 · {item.url} · 右键新建</p></>:<><h3>{item.title || item.id}</h3><p className="search-meta">{typeof item.path==='string'?item.path:item.breadcrumb || (item.path as unknown as {title:string}[] || []).map(x=>x.title).join(' / ')}{item.note?' · '+item.note:''} · {item.url} · 右键编辑</p></>}
      {!usage?<ResultActions item={item} index={index}/>:null}
    </div>
  </div>;
}, (before,after)=>{
  if(before.index!==after.index || (before.index===before.snapshot.state.index)!==(after.index===after.snapshot.state.index)) return false;
  const a=before.item,b=after.item;
  if(Object.keys(a).length!==Object.keys(b).length || Object.keys(a).some(key=>a[key]!==b[key])) return false;
  const previous=before.snapshot,next=after.snapshot;
  if(previous.showUncachedWebIcons!==next.showUncachedWebIcons || previous.state.config!==next.state.config) return false;
  if(a.type==='clipboard') return previous.state.expandedClipboard.has(Number(a.id))===next.state.expandedClipboard.has(Number(a.id)) && previous.state.editingClipboard===next.state.editingClipboard;
  if(a.type==='dns') return previous.state.dnsResult===next.state.dnsResult && previous.state.dnsIpResults===next.state.dnsIpResults;
  if(a.type==='app' && a.usageSection) return previous.state.appResults===next.state.appResults;
  // History panels can change independently of their tool result.
  if(['network','port'].includes(a.type)) return false;
  return true;
});
export function Results({snapshot}: {snapshot:SearchSnapshot}) {
  if(!snapshot.state.config) return <p className="search-empty">{snapshot.statusText || '配置加载中…'}</p>;
  if(!snapshot.items.length) return <p className="search-empty">{snapshot.paging.loading?'正在加载…':'没有匹配项'}</p>;
  const {items,plan}=snapshot, rows:React.ReactNode[]=[];
  for(let i=plan?.from || 0;i<(plan?.to ?? items.length);) {
    const item=items[i];
    if(item.usageSection) {
      const section=item.usageSection, group:React.ReactNode[]=[];
      while(i<(plan?.to ?? items.length) && items[i].usageSection===section) {group.push(<Row key={`${section}:${items[i].type}:${items[i].id || items[i].path || items[i].url}`} item={items[i]} index={i} snapshot={snapshot}/>);i++;}
      rows.push(<section key={`usage:${section}`} data-group={`usage:${section}`}><div className="search-section flex justify-between"><strong>{section==='frequent'?'常用入口':'最近使用'}</strong><small>{section==='frequent'?'按热度':'刚刚打开'}</small></div><div className="usage-strip flex gap-2 overflow-x-auto">{group}</div></section>);
    } else {rows.push(<Fragment key={`${item.type}:${item.id || item.path || item.url || item.title}`}><Row item={item} index={i} snapshot={snapshot}/></Fragment>);i++;}
  }
  return <>{plan?<div aria-hidden="true" style={{height:plan.before}}/>:null}{rows}{plan?<div aria-hidden="true" style={{height:plan.after}}/>:null}{snapshot.paging.loading || !snapshot.paging.hasMore?<p className="search-empty">{snapshot.paging.loading?'正在加载更多…':'已经到底了'}</p>:null}</>;
}
