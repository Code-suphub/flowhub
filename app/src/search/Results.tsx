import { Fragment, memo, useState } from 'react';
import { AppWindow, Clipboard as ClipboardIcon, File, FileText, Folder, Globe, Link2, Plus, ShieldCheck } from 'lucide-react';
import { Button } from '../shared/ui';
import { Textarea } from '../components/ui/textarea';
import { ToolContent } from './Tools';
import { host, type SearchItem, type SearchSnapshot } from './types';

const tools = new Set(['calculation','timestamp','jwt','ip','dns','cloudflare','proxy','port','network','public-ip','json','url-tool']);
const imageUrl = (value: unknown) => /^(https?:\/\/|data:image\/|(?:\.\/|\/)?assets\/)/i.test(String(value || ''));
const previewText = (value: unknown, full: boolean, limit = 220) => { const text = String(value || ''); return full || text.length <= limit ? text : text.slice(0, limit) + '…'; };
function itemMeta(item:SearchItem) {
  if(item.type==='app')return ['应用',item.fileName,item.path].filter(Boolean).join(' · ');
  const path=typeof item.path==='string'?item.path:item.breadcrumb || (Array.isArray(item.path)?(item.path as unknown as {title:string}[]).map(entry=>entry.title).join(' / '):'');
  return [path,item.note,item.url].filter(Boolean).join(' · ');
}
function Icon({item,snapshot}: {item:SearchItem;snapshot:SearchSnapshot}) {
  let url = item.type==='app' ? item.iconUrl || snapshot.state.appResults.find((a:SearchItem)=>a.path===item.path)?.iconUrl : item.type==='clipboard'?item.imageUrl || item.fileIconUrl:imageUrl(item.icon)?item.icon:'';
  const web = ['page','web'].includes(item.type);
  if(web && (snapshot.failedWebIcons.has(url) || (!snapshot.showUncachedWebIcons && !snapshot.loadedWebIcons.has(url)))) url='';
  const Glyph=item.type==='app'?AppWindow:item.type==='memo'?FileText:item.type==='clipboard'?(item.kind==='file'?item.fileType==='folder'?Folder:File:ClipboardIcon):item.type==='web-add'?Plus:web?Globe:item.type==='twofa'?ShieldCheck:Link2;
  const customIcon=!imageUrl(item.icon) && item.icon?String(item.icon):'';
  return <span className="search-icon" aria-hidden="true">{url?<img src={url} {...(web?{'data-web-icon':url}:{})} loading="lazy" decoding="async" alt=""/>:customIcon || <Glyph size={18} strokeWidth={1.65}/>}</span>;
}
export function resultActions(item:SearchItem): [string,string][] {
  const actions: [string,string][]=[];
  if(['page','web','web-add','app'].includes(item.type)) {
    actions.push(['open',item.type==='web-add'?'添加到网页目录':'打开']);
    if(item.type==='app'?item.path:/^(https?:\/\/|[a-z0-9.-]+\.[a-z]{2,})/i.test(item.url || '')) actions.push(['copy',item.type==='app'?'复制路径':'复制链接']);
    if(item.type==='page') actions.push(['edit','编辑网页']);
  }
  if(item.type==='memo') {if(item.content?.trim()) actions.push(['copy','复制命令']);actions.push(['open','粘贴']);}
  if(item.type==='twofa') actions.push(['copy','复制验证码']);
  if(['calculation','timestamp','jwt'].includes(item.type)) actions.push(['copy','复制结果']);
  if(['dns','ip'].includes(item.type)) actions.push(['copy-query','复制查询命令']);
  return actions;
}
function ClipButton({item,action,children}: {item:SearchItem;action:string;children:React.ReactNode}) {
  return <Button className="tool-action" data-clipboard-action={action} data-clipboard-id={item.id}>{children}</Button>;
}
function Clipboard({item,snapshot,full,selected}: {item:SearchItem;snapshot:SearchSnapshot;full:boolean;selected:boolean}) {
  const content=String(item.content || ''), expanded=snapshot.state.expandedClipboard.has(Number(item.id));
  const expandable=item.kind==='text' && (content.length>120 || /\n[^\n]*\n/.test(content));
  const preview=expanded?content:content.slice(0,selected?600:160).split('\n',selected?6:3).slice(0,selected?5:2).join('\n');
  const stamp=item.lastSeenAt?new Date(item.lastSeenAt):null;
  const metadata=['剪贴板',stamp&&Number.isFinite(stamp.getTime())?stamp.toLocaleString():'',`${item.copyCount || 1} 次`,String(item.hash||'').slice(0,12),item.pinnedAt?'★ 已置顶':''].filter(Boolean).join(' · ');
  if(snapshot.state.editingClipboard?.id===Number(item.id)) return <><h3>编辑文本副本</h3><p className="search-meta">保存后写入一条新记录，原记录保留</p><Textarea className="clipboard-editor" data-clipboard-editor rows={5} spellCheck={false} aria-label="编辑文本副本" defaultValue={snapshot.state.editingClipboard.text} onClick={e=>e.stopPropagation()}/><div className="search-actions"><ClipButton item={item} action="edit-save">保存副本（⌘↩）</ClipButton><ClipButton item={item} action="edit-cancel">取消（Esc）</ClipButton></div></>;
  return <><div className={`clipboard-title ${expanded?'is-expanded':''}`}>{item.kind==='image'?`图片${item.sourceName?' · '+item.sourceName:''}`:item.kind==='file'?previewText((item.fileNames||[]).join(' · ') || `${item.fileCount || 0} 个文件`,full):preview+(preview.length<content.length?'…':'') || '空文本'}</div>
    <div className="clipboard-meta flex items-center gap-2"><p className="search-meta flex-1">{metadata}</p>{expandable?<Button className="clipboard-toggle tool-action" data-clipboard-toggle={item.id} aria-label={expanded?'收起剪贴板完整内容':'展开剪贴板完整内容'} aria-expanded={expanded}>{expanded?'收起':'展开'}</Button>:null}</div>
  </>;
}
const Row = memo(function Row({item,index,snapshot}: {item:SearchItem;index:number;snapshot:SearchSnapshot}) {
  const isTool=tools.has(item.type), usage=Boolean(item.usageSection);
  const [manual,setManual]=useState<boolean|null>(null), selected=index===snapshot.state.index;
  const meta=itemMeta(item), title=String(item.title || item.id || ''), content=String(item.content || ''), description=String(item.description || '');
  const oversized=[title,meta,content,description].some(value=>value.length>8000), full=manual ?? (selected && !oversized);
  const expandable=!usage&&!isTool&&item.type!=='clipboard'&&(title.length>80||meta.length>180||content.length>180||content.includes('\n')||description.length>180);
  return <div id={`search-result-${index}`} role="option" aria-selected={selected} className={`result ${item.type}-result ${usage?'usage-tile':''} ${selected?'active':''}`} data-i={index} data-full-content={isTool?undefined:usage?false:full}>
    {!isTool && (item.type!=='clipboard'||item.kind!=='text')?<Icon item={item} snapshot={snapshot}/>:null}
    <div className="search-row-content min-w-0 flex-1">{usage?<h3 className="search-tile-title">{previewText(item.title || '未命名',false,80)}</h3>:item.type==='clipboard'?<Clipboard item={item} snapshot={snapshot} full={full} selected={selected}/>:isTool?<ToolContent item={item} snapshot={snapshot}/>:item.type==='memo'?<><p className="search-meta">{previewText(host.FlowHubMemoCatalog?.categorySegments(item.category || '').join(' › ') || item.category,full)}</p><h3>{previewText(item.title || '未命名备忘',full,80)}</h3><code className="search-command">{previewText(full?content:content.split('\n',3).slice(0,2).join('\n'),full)}</code>{item.description?<p className="search-meta">{previewText(item.description,full)}</p>:null}</>:item.type==='twofa'?<><h3>{previewText(item.title || item.id || '2FA',full,80)}</h3><p className="search-meta">2FA 验证码{item.issuer?' · '+previewText(item.issuer,full):''}</p></>:item.type==='app'?<><h3>{previewText(item.title || '未命名应用',full,80)}</h3><p className="search-meta">{previewText(meta,full)}</p></>:item.type==='web-add'?<><h3>添加到网页配置</h3><p className="search-meta">未找到匹配网页 · {previewText(item.url,full)}</p></>:<><h3>{previewText(item.title || item.id,full,80)}</h3><p className="search-meta">{previewText(meta,full)}</p></>}
      {expandable?<Button className="search-content-toggle tool-action" aria-expanded={full} onMouseDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();setManual(!full);}}>{full?'收起内容':'展开内容'}</Button>:null}
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
  const showUsage=!snapshot.state.query.trim()&&['all','app','web'].includes(snapshot.state.scope);
  const hasFrequent=snapshot.items.some(item=>item.usageSection==='frequent'),hasRecent=snapshot.items.some(item=>item.usageSection==='recent');
  const emptyUsage=(section:string)=><div className="search-usage-group" role="group" aria-label={section==='frequent'?'常用入口':'最近使用'}><h2 className="search-usage-label">{section==='frequent'?'常用':'最近'}</h2><p className="search-usage-empty">{section==='frequent'?'暂无常用入口':'暂无最近使用'}</p></div>;
  if(!snapshot.items.length) return <>{showUsage?<>{emptyUsage('frequent')}{emptyUsage('recent')}</>:<p className="search-empty">{snapshot.paging.loading?'正在加载…':'没有匹配项'}</p>}</>;
  const {items,plan}=snapshot, rows:React.ReactNode[]=[];
  for(let i=plan?.from || 0;i<(plan?.to ?? items.length);) {
    const item=items[i];
    if(item.usageSection) {
      const section=item.usageSection, group:React.ReactNode[]=[];
      while(i<(plan?.to ?? items.length) && items[i].usageSection===section) {group.push(<Row key={`${section}:${items[i].type}:${items[i].id || items[i].path || items[i].url}`} item={items[i]} index={i} snapshot={snapshot}/>);i++;}
      rows.push(<section key={`usage:${section}`} data-group={`usage:${section}`} aria-label={section==='frequent'?'常用入口':'最近使用'}>{section==='recent'&&!hasFrequent?emptyUsage('frequent'):null}<div className="search-usage-group"><h2 className="search-usage-label">{section==='frequent'?'常用':'最近'}</h2><div className="usage-strip flex gap-2 overflow-x-auto">{group}</div></div>{section==='frequent'&&!hasRecent?emptyUsage('recent'):null}</section>);
    } else {const key=`${item.type}:${item.id || item.path || item.url || item.title}`;rows.push(showUsage&&!hasFrequent&&!hasRecent&&i===0?<div key={key} data-group="empty-usage-and-first-result">{emptyUsage('frequent')}{emptyUsage('recent')}<Row item={item} index={i} snapshot={snapshot}/></div>:<Fragment key={key}><Row item={item} index={i} snapshot={snapshot}/></Fragment>);i++;}
  }
  return <>{plan?<div aria-hidden="true" style={{height:plan.before}}/>:null}{rows}{plan?<div aria-hidden="true" style={{height:plan.after}}/>:null}{snapshot.paging.loading || !snapshot.paging.hasMore?<p className="search-empty">{snapshot.paging.loading?'正在加载更多…':'已经到底了'}</p>:null}</>;
}
