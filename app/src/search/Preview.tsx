import { useEffect, useRef, type MouseEventHandler } from 'react';
import { ArrowLeft, Clipboard, FileText, Image, Pin } from 'lucide-react';
import { Button } from '../shared/ui';
import { ResultIcon } from './Results';
import type { SearchItem, SearchSnapshot } from './types';

export const canPreview = (item?: SearchItem) => Boolean(item && ['app', 'page', 'web', 'web-add', 'clipboard', 'memo', 'twofa'].includes(item.type));
export function previewNeighbor(items:SearchItem[], index:number, direction:-1|1) {
  for(let next=index+direction;next>=0 && next<items.length;next+=direction)if(canPreview(items[next]))return next;
  return -1;
}
export function primaryLabel(item?: SearchItem) {
  if (!item) return '打开';
  const tools:Record<string,string>={calculation:'复制结果',timestamp:'复制结果',jwt:'复制结果',json:'复制结果','url-tool':'复制结果',ip:'复制信息',proxy:'复制信息',dns:'查询并复制',cloudflare:'检测',port:'复制详情',network:'执行'};
  if(tools[item.type])return tools[item.type];
  if(item.toolId)return '执行';
  if (item.type === 'clipboard' || item.type === 'memo') return '粘贴';
  if (item.type === 'twofa') return '复制验证码';
  if (item.type === 'web-add') return '添加网页';
  return '打开';
}
function itemTitle(item: SearchItem) {
  if (item.type !== 'clipboard') return String(item.title || item.id || '未命名');
  if (item.kind === 'image') return item.sourceName ? `来自 ${item.sourceName} 的图片` : '图片';
  if (item.kind === 'file') return (item.fileNames || []).join('、') || `${item.fileCount || 0} 个文件`;
  return '文本内容';
}
const typeNames: Record<string, string> = { app: '应用', page: '网页', web: '网页', 'web-add': '网页', clipboard: '剪贴板', memo: '命令备忘', twofa: '验证码' };

export function Preview({item, index, snapshot, onBack, onAction, onNavigate}: {item: SearchItem; index: number; snapshot: SearchSnapshot; onBack: () => void; onAction: MouseEventHandler<HTMLElement>; onNavigate:(direction:-1|1)=>void}) {
  const body = useRef<HTMLDivElement>(null);
  const identity = `${item.type}:${item.id ?? item.path ?? item.url ?? ''}`;
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [identity]);
  const clipboard = item.type === 'clipboard';
  const breadcrumb = item.breadcrumb || (Array.isArray(item.path) ? item.path.map((entry: {title: string}) => entry.title).join(' / ') : item.type !== 'app' && typeof item.path === 'string' ? item.path : '');
  const content = String(item.content || ''), text = content.slice(0, 20000);
  const readonly = document.documentElement.dataset.weborgReadonly === 'true';
  const date = item.lastSeenAt ? new Date(item.lastSeenAt) : null;
  const copyLabel = item.type === 'app' ? '复制路径' : clipboard ? item.kind === 'file' ? '复制文件名' : '复制全文' : item.type === 'memo' ? '复制命令' : '复制链接';
  const copyable = ['app', 'page', 'web', 'web-add', 'memo'].includes(item.type) || (clipboard && item.kind !== 'image');
  return <aside className="search-preview" aria-label="结果预览" onClick={onAction} onKeyDown={event=>{
    if(event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.nativeEvent.isComposing && ['ArrowUp','ArrowDown'].includes(event.key)) {
      if((event.target as HTMLElement).closest('input,textarea,[contenteditable="true"]'))return;
      event.preventDefault();event.stopPropagation();onNavigate(event.key==='ArrowUp'?-1:1);
    }
  }}>
    <div className="search-preview-toolbar">
      <Button variant="ghost" size="sm" className="preview-back" onClick={onBack}><ArrowLeft data-icon="inline-start"/>返回结果</Button>
      <span className="preview-type">{typeNames[item.type]}</span>
    </div>
    <div ref={body} className="search-preview-body" tabIndex={0} aria-label="预览内容">
      <div className="preview-identity"><ResultIcon item={item} snapshot={snapshot}/><div>{clipboard ? <p className="preview-eyebrow">{ ({text:`${content.length.toLocaleString()} 字符`, image:'图片记录', file:'文件记录'}[item.kind as string] || '剪贴板记录')}</p> : null}<h2>{itemTitle(item)}</h2></div></div>
      {clipboard && item.kind === 'image' ? <div className="preview-image">{item.imageUrl ? <img src={item.imageUrl} alt="剪贴板图片预览" decoding="async"/> : <><Image aria-hidden="true"/><p>图片预览暂不可用，仍可粘贴原图。</p></>}</div> : null}
      {(clipboard && item.kind === 'text') || item.type === 'memo' ? <pre className={`preview-content ${item.type === 'memo' ? 'preview-code' : ''}`}>{text || '空文本'}</pre> : null}
      {content.length > text.length ? <p className="preview-note">内容较长，预览显示前一部分。复制全文可获取完整内容。</p> : null}
      {item.type === 'app' ? <dl className="preview-properties"><dt>位置</dt><dd>{item.path}</dd>{item.fileName ? <><dt>文件名</dt><dd>{item.fileName}</dd></> : null}</dl> : null}
      {['page', 'web', 'web-add'].includes(item.type) ? <><dl className="preview-properties"><dt>网址</dt><dd>{item.url}</dd>{breadcrumb ? <><dt>目录</dt><dd>{breadcrumb}</dd></> : null}</dl>{item.note ? <p className="preview-note">{item.note}</p> : null}</> : null}
      {item.type === 'memo' && item.description ? <p className="preview-note">{item.description}</p> : null}
      {item.type === 'twofa' ? <><p className="preview-note">按回车或点击下方按钮，复制当前验证码。</p>{item.issuer ? <dl className="preview-properties"><dt>发行方</dt><dd>{item.issuer}</dd></dl> : null}</> : null}
      {clipboard ? <dl className="preview-properties">{item.sourceName ? <><dt>来源</dt><dd>{item.sourceName}</dd></> : null}{date && Number.isFinite(date.getTime()) ? <><dt>复制时间</dt><dd>{date.toLocaleString()}</dd></> : null}<dt>使用次数</dt><dd>{item.copyCount || 1} 次</dd>{item.pinnedAt ? <><dt>状态</dt><dd>已置顶</dd></> : null}{item.kind === 'file' ? <><dt>文件</dt><dd>{(item.fileNames || []).join('\n') || `${item.fileCount || 0} 个文件`}</dd></> : null}</dl> : null}
    </div>
    <div className="search-preview-actions">
      {copyable ? <Button className="tool-action" variant="outline" size="sm" disabled={readonly} data-result-action="copy" data-result-index={index}><Clipboard data-icon="inline-start"/>{copyLabel}</Button> : null}
      {clipboard ? <><Button className="tool-action" variant="ghost" size="sm" disabled={readonly} data-clipboard-action="pin" data-clipboard-id={item.id}><Pin data-icon="inline-start"/>{item.pinnedAt ? '取消置顶' : '置顶'}</Button>{item.kind === 'text' ? <Button className="tool-action" variant="ghost" size="sm" disabled={readonly} data-clipboard-action="edit" data-clipboard-id={item.id}><FileText data-icon="inline-start"/>编辑副本</Button> : null}</> : null}
    </div>
  </aside>;
}
