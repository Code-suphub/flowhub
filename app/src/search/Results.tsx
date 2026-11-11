import { Fragment, memo, useMemo } from 'react';
import { AppWindow, Clipboard as ClipboardIcon, File, FileText, Folder, Globe, Link2, Plus, ShieldCheck, PanelRight } from 'lucide-react';
import { FeatureIcon } from '../shared/FeatureIcon';
import { Button } from '../shared/ui';
import { Textarea } from '../components/ui/textarea';
import { ToolContent } from './Tools';
import { Badge } from '../components/ui/badge';
import { Highlight, searchPattern } from './Highlight';
import { NoResults } from './NoResults';
import { host, type SearchItem, type SearchSnapshot } from './types';

const tools = new Set(['calculation','timestamp','jwt','ip','dns','cloudflare','proxy','port','network','public-ip','json','url-tool']);
export const resultKind = (item: SearchItem) => ({app:'应用',page:'网页',web:'网页','web-add':'网页',clipboard:'剪贴板',memo:'命令',twofa:'验证码'}[item.type] || '工具');
export const waitingForMail = (item?: SearchItem) => Boolean(item?.mailAccount && !item.mailCodeId);
export const mailWaitingLabel = (item?:SearchItem) => item?.credentialsMissing?'请填写邮箱授权码':'等待验证码';
const imageUrl = (value: unknown) => /^(https?:\/\/|data:image\/|(?:\.\/|\/)?assets\/)/i.test(String(value || ''));
const excerpt = (value: unknown, limit = 100) => String(value || '').slice(0, limit * 4).replace(/\s+/g, ' ').slice(0, limit);
function itemMeta(item: SearchItem) {
  if (item.type === 'app') return String(item.path || item.fileName || '应用');
  if (item.type === 'clipboard') {
    const kind = item.kind === 'image' ? '图片' : item.kind === 'file' ? '文件' : '文本';
    const date = item.lastSeenAt ? new Date(item.lastSeenAt) : null;
    return [kind,item.note?`备注：${excerpt(item.note,60)}`:'', item.sourceName, date && Number.isFinite(date.getTime()) ? date.toLocaleString() : '', item.pinnedAt ? '已置顶' : ''].filter(Boolean).join(' · ');
  }
  if (item.type === 'memo') return host.FlowHubMemoCatalog?.categorySegments(item.category || '').join(' › ') || item.category || '命令备忘';
  if (item.type === 'twofa') {
    if (waitingForMail(item)) return `${item.issuer || '邮箱'} · ${mailWaitingLabel(item)}`;
    const received = item.source === 'mail' && typeof item.receivedAt === 'number' ? new Date(item.receivedAt) : null;
    return [item.issuer || '验证码', received?.toLocaleTimeString()].filter(Boolean).join(' · ');
  }
  return item.breadcrumb || item.note || item.url || '';
}
export function ResultIcon({item,snapshot}: {item: SearchItem; snapshot: SearchSnapshot}) {
  let url = item.type === 'app' ? item.iconUrl || snapshot.state.appResults.find((a: SearchItem) => a.path === item.path)?.iconUrl : item.type === 'clipboard' ? item.imageUrl || item.fileIconUrl : imageUrl(item.icon) ? item.icon : '';
  const web = ['page','web'].includes(item.type);
  if (web && (snapshot.failedWebIcons.has(url) || (!snapshot.showUncachedWebIcons && !snapshot.loadedWebIcons.has(url)))) url = '';
  const Glyph = item.type === 'app' ? AppWindow : item.type === 'memo' ? FileText : item.type === 'clipboard' ? item.kind === 'file' ? item.fileType === 'folder' ? Folder : File : ClipboardIcon : item.type === 'web-add' ? Plus : web ? Globe : item.type === 'twofa' ? ShieldCheck : Link2;
  const customIcon = !imageUrl(item.icon) && item.icon ? String(item.icon) : '';
  const tone=item.type==='clipboard'?'orange':item.type==='memo'?'amber':item.type==='twofa'?'violet':item.type==='app'?'blue':'sky';
  return <span className="search-icon" aria-hidden="true">{url ? <img src={url} {...(web ? {'data-web-icon':url} : {})} loading="lazy" decoding="async" alt=""/> : customIcon || <FeatureIcon icon={Glyph} tone={tone} size="small"/>}</span>;
}
export function resultActions(item: SearchItem): [string,string][] {
  const actions: [string,string][] = [];
  if (['page','web','web-add','app'].includes(item.type)) {
    actions.push(['open', item.type === 'web-add' ? '添加到网页目录' : '打开']);
    if (item.type === 'app' ? item.path : /^(https?:\/\/|[a-z0-9.-]+\.[a-z]{2,})/i.test(item.url || '')) actions.push(['copy', item.type === 'app' ? '复制路径' : '复制链接']);
    if (item.type === 'page') actions.push(['edit','编辑网页']);
  }
  if (item.type === 'memo') { if (item.content?.trim()) actions.push(['copy','复制命令']); actions.push(['open','粘贴']); }
  if (item.type === 'twofa' && !waitingForMail(item)) actions.push(['open','粘贴验证码'],['copy','复制验证码']);
  if (['calculation','timestamp','jwt'].includes(item.type)) actions.push(['copy','复制结果']);
  if (['dns','ip'].includes(item.type)) actions.push(['copy-query','复制查询命令']);
  return actions;
}
function ClipboardEditor({item,snapshot}: {item: SearchItem; snapshot: SearchSnapshot}) {
  return <><h3>编辑文本副本</h3><p className="search-meta">保存后写入一条新记录，原记录保留</p>
    <Textarea className="clipboard-editor" data-clipboard-editor rows={5} spellCheck={false} aria-label="编辑文本副本" defaultValue={snapshot.state.editingClipboard.text} onClick={e => e.stopPropagation()}/>
    <div className="search-actions">{[['edit-save','保存副本（⌘↩）'],['edit-cancel','取消（Esc）']].map(([action,label]) => <Button key={action} className="tool-action" data-clipboard-action={action} data-clipboard-id={item.id}>{label}</Button>)}</div>
  </>;
}
const Row = memo(function Row({item,index,snapshot,onPreview,pattern}: {item: SearchItem; index: number; snapshot: SearchSnapshot; onPreview: (index: number) => void; pattern:RegExp|null}) {
  const isTool = tools.has(item.type), usage = Boolean(item.usageSection), selected = index === snapshot.state.index;
  const editing = item.type === 'clipboard' && snapshot.state.editingClipboard?.id === Number(item.id);
  const title = item.type === 'clipboard' ? item.kind === 'image' ? `图片${item.sourceName ? ' · '+item.sourceName : ''}` : item.kind === 'file' ? (item.fileNames || []).join('、') || `${item.fileCount || 0} 个文件` : excerpt(item.content) || '空文本' : item.title || item.id || '未命名';
  return <div id={`search-result-${index}`} role="option" aria-selected={selected} aria-setsize={snapshot.items.length} aria-posinset={index + 1} className={`result ${item.type}-result ${usage ? 'usage-tile' : ''} ${selected ? 'active' : ''}`} data-i={index}>
    {!isTool && !editing ? <ResultIcon item={item} snapshot={snapshot}/> : null}
    <div className="search-row-content min-w-0 flex-1">{editing ? <ClipboardEditor item={item} snapshot={snapshot}/> : isTool ? <ToolContent item={item} snapshot={snapshot}/> : <><h3 className={usage ? 'search-tile-title' : item.type === 'clipboard' ? 'clipboard-title' : undefined}><Highlight text={String(title)} pattern={pattern}/></h3>{!usage ? <p className="search-meta"><Highlight text={excerpt(itemMeta(item), 180)} pattern={pattern}/></p> : null}</>}</div>
    {!usage && !isTool && !editing && snapshot.state.scope==='all' ? <Badge variant="outline" className="result-kind shrink-0">{resultKind(item)}</Badge> : null}
    {!usage && !isTool && !editing ? <Button variant="ghost" size="icon-sm" className="result-preview-button tool-action" aria-label="预览此结果" onMouseDown={event => event.stopPropagation()} onClick={event => {event.stopPropagation(); onPreview(index);}}><PanelRight aria-hidden="true"/></Button> : null}
  </div>;
}, (before,after) => {
  if (before.onPreview !== after.onPreview) return false;
  if (before.index !== after.index || (before.index === before.snapshot.state.index) !== (after.index === after.snapshot.state.index)) return false;
  const a=before.item,b=after.item;
  if (Object.keys(a).length !== Object.keys(b).length || Object.keys(a).some(key => a[key] !== b[key])) return false;
  const previous=before.snapshot,next=after.snapshot;
  if (previous.state.query !== next.state.query || previous.state.scope !== next.state.scope) return false;
  if (previous.items.length !== next.items.length || previous.showUncachedWebIcons !== next.showUncachedWebIcons || previous.state.config !== next.state.config) return false;
  if (a.type === 'clipboard') return previous.state.editingClipboard === next.state.editingClipboard;
  if (a.type === 'dns') return previous.state.dnsResult === next.state.dnsResult && previous.state.dnsIpResults === next.state.dnsIpResults;
  if (a.type === 'app' && a.usageSection) return previous.state.appResults === next.state.appResults;
  return !['network','port'].includes(a.type);
});
export function Results({snapshot,onPreview,onClear,onSearchAll}: {snapshot: SearchSnapshot; onPreview: (index: number) => void; onClear:()=>void; onSearchAll:()=>void}) {
  const pattern=useMemo(()=>searchPattern(String(snapshot.state.query || '')), [snapshot.state.query]);
  const ready=Boolean(snapshot.state.config);
  const showUsage=ready && !snapshot.state.query.trim() && ['all','app','web'].includes(snapshot.state.scope);
  if(ready && !snapshot.items.length && !showUsage)return <><div id="search-results" role="listbox" aria-label="搜索结果" aria-busy={snapshot.paging.loading || false}/><NoResults snapshot={snapshot} onClear={onClear} onSearchAll={onSearchAll}/></>;
  const hasFrequent=snapshot.items.some(item => item.usageSection === 'frequent'), hasRecent=snapshot.items.some(item => item.usageSection === 'recent');
  const emptyUsage=(section:string) => <div className="search-usage-group" role="group" aria-label={section === 'frequent' ? '常用入口' : '最近使用'}><h2 className="search-usage-label">{section === 'frequent' ? '常用' : '最近'}</h2><p className="search-usage-empty">{section === 'frequent' ? '暂无常用入口' : '暂无最近使用'}</p></div>;
  const {items,plan}=snapshot, rows: React.ReactNode[]=[];
  let message='';
  if (!ready) message=snapshot.statusText || '配置加载中…';
  else if (!items.length) {
    if (showUsage) rows.push(emptyUsage('frequent'),emptyUsage('recent'));
    else message=snapshot.paging.loading ? '正在加载…' : '没有匹配项';
  } else {
    for (let i=plan?.from || 0;i<(plan?.to ?? items.length);) {
      const item=items[i];
      if (item.usageSection) {
        const section=item.usageSection, group: React.ReactNode[]=[];
        while (i<(plan?.to ?? items.length) && items[i].usageSection === section) { group.push(<Row key={`${section}:${items[i].type}:${items[i].id || items[i].path || items[i].url}`} item={items[i]} index={i} snapshot={snapshot} onPreview={onPreview} pattern={pattern}/>); i++; }
        rows.push(<div key={`usage:${section}`} data-group={`usage:${section}`} role="group" aria-label={section === 'frequent' ? '常用入口' : '最近使用'}>{section === 'recent' && !hasFrequent ? emptyUsage('frequent') : null}<div className="search-usage-group" role="presentation"><h2 className="search-usage-label">{section === 'frequent' ? '常用' : '最近'}</h2><div className="usage-strip flex gap-2 overflow-x-auto" role="presentation">{group}</div></div>{section === 'frequent' && !hasRecent ? emptyUsage('recent') : null}</div>);
      } else {
        const key=`${item.type}:${item.id || item.path || item.url || item.title}`;
        const row=<Row item={item} index={i} snapshot={snapshot} onPreview={onPreview} pattern={pattern}/>;
        rows.push(showUsage && !hasFrequent && !hasRecent && i === 0 ? <div key={key} data-group="empty-usage-and-first-result" role="presentation">{emptyUsage('frequent')}{emptyUsage('recent')}{row}</div> : <Fragment key={key}>{row}</Fragment>); i++;
      }
    }
    message=snapshot.paging.loading ? '正在加载更多…' : '';
  }
  return <><div id="search-results" role="listbox" aria-label="搜索结果" aria-busy={snapshot.paging.loading || false}>{plan ? <div aria-hidden="true" style={{height:plan.before}}/> : null}{rows}{plan ? <div aria-hidden="true" style={{height:plan.after}}/> : null}</div>{message ? <p className="search-empty" role="status">{message}</p> : null}</>;
}
