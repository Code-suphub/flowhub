import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { FolderIcon, FolderOpenIcon, Globe2Icon, TerminalSquareIcon, MoreHorizontalIcon, PlusIcon, MoveRightIcon, Trash2Icon, ListChecksIcon } from 'lucide-react';
import { Button, Dialog, Input } from '../shared/ui';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { ActionMenu } from '../shared/ActionMenu';
import { CollectionField, CollectionHeading, CollectionEmpty, useCollectionPane } from './collection-ui';
import { Help, Select } from '../shared/controls';
import { Choice } from './fields';
import { host, readonly, write } from './api';
import { clone, entries, importWeb, moveNodes, moveMemo, removeNodes, webSelection, renameCategory, memoTree, type MemoBranch, type MemoMoveRef, type MemoDropPosition, type Bag, type Memo, type WebNode } from './model';
import { useTreeView } from './useTreeView';
import { useCatalogDragMotion } from './useCatalogDragMotion';
import { SettingsStore, useSettings } from './store';
import { useViewScroll, useViewState } from './view-state';

export function WebCatalog({ store }: { store: SettingsStore }) {
  const s = useSettings(store), preview = readonly(), sourceNodes: WebNode[] = s.config!.plugins.web.settings.items;
  const [previewNodes, setPreviewNodes] = useViewState<WebNode[] | null>('web:preview',null);
  const nodes = preview && previewNodes ? previewNodes : sourceNodes;
  const [selected, setSelected] = useViewState<string[]>('web:selected',[]), [expanded, setExpanded] = useViewState<Set<string>>('web:expanded',() => new Set(nodes.map(n => n.id))), [filter, setFilter] = useViewState('web:filter',''), [pending, setPending] = useState<Bag | null>(null), [overwrite, setOverwrite] = useState('skip'), [selectionMode, setSelectionMode] = useViewState('web:selection-mode',false);
  const deferred = useDeferredValue(filter).trim().toLowerCase(), all = useMemo(() => entries(nodes), [nodes]);
  const byId = useMemo(() => new Map(all.map(entry => [entry.node.id,entry])), [all]);
  const activeIds = useMemo(() => selected.filter(id => byId.has(id)), [byId,selected]);
  const selection = useMemo(() => webSelection(nodes,activeIds), [nodes,activeIds]);
  const node = byId.get(activeIds[0] || '')?.node;
  const [action, setAction] = useState<{kind:'delete'|'move';ids:string[];titles:string[];blocked:Set<string>;count:number;descendants:number;snapshot:string}|null>(null);
  const [moveTarget,setMoveTarget] = useState('root'), [actionError,setActionError] = useState('');
  function path(id: string) { const parts:string[]=[]; let entry=byId.get(id); while(entry) { parts.unshift(entry.node.title || entry.node.id); entry=entry.parent ? byId.get(entry.parent.id) : undefined; } return parts.join(' / '); }
  function prepareAction(kind:'delete'|'move') {
    if(preview || !selection.roots.length) return;
    setAction({kind,ids:selection.roots.map(node=>node.id),titles:selection.roots.map(node=>node.title || node.id),blocked:new Set(selection.blocked),count:selection.count,descendants:selection.descendants,snapshot:JSON.stringify(nodes)});
    setMoveTarget('root');setActionError('');
  }
  function applyAction() {
    if(!action || preview) return;
    const current=store.snapshot().config!.plugins.web.settings.items;
    if(JSON.stringify(current)!==action.snapshot) { setActionError('目录已变化，请关闭并重新选择后再试。');return; }
    if(action.kind==='delete') { editNodes(removeNodes(current,action.ids));pane.back('', 'data-node-id'); }
    else { const target=moveTarget==='root'?'':moveTarget.slice(5);editNodes(moveNodes(current,action.ids,target));setExpanded(previous=>new Set([...previous,...all.filter(entry=>entry.node.id===target || entries(entry.node.children || []).some(child=>child.node.id===target)).map(entry=>entry.node.id)]));setFilter(''); }
    setAction(null);
  }
  const stopPointerDrag = useRef<(() => void) | null>(null);
  const suppressClickUntil = useRef(0);
  const [dropTarget, setDropTarget] = useState<{id:string;position:'before'|'inside'|'after'}|null>(null);
  const dropAt = (row:HTMLElement, y:number) => {
    const rect=row.getBoundingClientRect(), ratio=(y-rect.top)/rect.height;
    const position=ratio<.25?'before':ratio>.75?'after':'inside';
    const id=row.dataset.nodeId!;
    setDropTarget(current=>current?.id===id&&current.position===position?current:{id,position});
    return {id,position} as const;
  };
  useEffect(() => () => stopPointerDrag.current?.(), []);
  function beginPointerDrag(source: string, event: ReactPointerEvent<HTMLElement>, handle = false) {
    if (event.button !== 0 || (event.pointerType === 'touch' && !handle)) return;
    const tree = event.currentTarget.closest<HTMLElement>('.settings-tree');
    if (!tree) return;
    stopPointerDrag.current?.();
    const { pointerId, clientX, clientY } = event;
    const sourceRow = event.currentTarget.closest<HTMLElement>('[data-node-id]');
    if (!sourceRow) return;
    const movingIds = selected.includes(source) ? selected : [source];
    const moving = new Set(movingIds.flatMap(id => {
      const entry = all.find(entry => entry.node.id === id);
      return [id, ...entries(entry?.node.children || []).map(entry => entry.node.id)];
    }));
    let moved = false;
    const rowAt = (x: number, y: number) => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-node-id]');
      return row && tree.contains(row) && !moving.has(row.dataset.nodeId!) ? row : null;
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('keydown', onKey);
      dragMotion.end();
      if (stopPointerDrag.current === cleanup) stopPointerDrag.current = null;
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (!moved && Math.hypot(move.clientX - clientX, move.clientY - clientY) < 5) return;
      if (!moved) dragMotion.lift(sourceRow, tree, movingIds, clientX, clientY);
      moved = true;
      dragMotion.move(move.clientX, move.clientY);
      move.preventDefault();
      const row = rowAt(move.clientX, move.clientY);
      if (row) dropAt(row, move.clientY);
      else setDropTarget(null);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      if (moved) {
        suppressClickUntil.current = Date.now() + 250;
        const row = rowAt(up.clientX, up.clientY);
        if (row) {
          const { id, position } = dropAt(row, up.clientY);
          dragMotion.captureDrop();
          editNodes(moveNodes(nodes, movingIds, id, position));
          setExpanded(prev => new Set([...prev, id]));
        }
      }
      cleanup();
      setDropTarget(null);
    };
    const onCancel = () => { cleanup(); setDropTarget(null); };
    const onKey = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); onCancel(); } };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    window.addEventListener('keydown', onKey);
    stopPointerDrag.current = cleanup;
  }
  useEffect(() => { if (s.webSelection) { const incoming=s.webSelection;setFilter('');setSelected([incoming]); pane.openDetail(); setExpanded(prev => new Set([...prev, ...all.filter(e => entries(e.node.children || []).some(child => child.node.id === incoming)).map(e => e.node.id)]));store.patch({webSelection:undefined}); } }, [s.webSelection,store]);
  const visible = useMemo(() => {
    const matched = new Set(all.filter(e => [e.node.title, e.node.url, e.node.note, e.node.id].join(' ').toLowerCase().includes(deferred)).map(e => e.node.id));
    const list: typeof all = [];
    const visit = (items: WebNode[], depth: number, parent: WebNode | null) => items.forEach(node => {
      if (deferred && !matched.has(node.id) && !entries(node.children || []).some(e => matched.has(e.node.id))) return;
      list.push({ node, depth, parent }); if (deferred || expanded.has(node.id)) visit(node.children || [], depth + 1, node);
    }); visit(nodes, 0, null); return list;
  }, [all, nodes, deferred, expanded]);
  const view = useTreeView(visible.map(e => e.node.id), selected[0] || '', deferred);
  const pane = useCollectionPane('web',view.ref);
  const dragMotion = useCatalogDragMotion();
  const [width, setWidth] = useState(() => { try { return Number(localStorage.getItem('flowhub:web-tree-width')) || 260; } catch { return 260; } });
  const resizing = useRef<{ x: number; width: number } | null>(null);
  function resize(value: number) { const next = Math.max(220, Math.min(380, value)); setWidth(next); if (!readonly()) try { localStorage.setItem('flowhub:web-tree-width', String(next)); } catch { /* presentation only */ } }
  const plan = useMemo(() => pending ? importWeb(nodes, pending.items, overwrite === 'overwrite') : null, [nodes, pending, overwrite]);
  const editNodes = (next: WebNode[]) => {
    if (preview) setPreviewNodes(next);
    else store.edit(c => { c.plugins.web.settings.items = next; });
  };
  function add(where: 'root' | 'child' | 'sibling') {
    const id = `node-${crypto.randomUUID()}`; const next = clone(nodes), context = entries(next).find(e => e.node.id === node?.id);
    const added = { id, title: '新节点', children: [] };
    if (where === 'child' && context) { (context.node.children ||= []).push(added); setExpanded(prev => new Set([...prev, context.node.id])); }
    else if (where === 'sibling' && context) { const siblings = context.parent?.children || next; siblings.splice(siblings.indexOf(context.node) + 1, 0, added); }
    else next.push(added);
    editNodes(next); setFilter('');setSelectionMode(false);setSelected([id]);setExpanded(previous=>new Set([...previous,...entries(next).filter(entry=>entries(entry.node.children || []).some(child=>child.node.id===id)).map(entry=>entry.node.id)]));pane.openDetail(true);
  }
  function select(id: string, multi: boolean) { setSelected(prev => multi || selectionMode ? prev.includes(id) ? prev.filter(v => v !== id) : [id, ...prev] : [id]); if(!multi && !selectionMode) pane.openDetail(); }
  return <div ref={pane.ref} className="settings-catalog settings-collection-page">
    <div className="settings-collection-toolbar flex flex-wrap items-center justify-between gap-3">
      <span className="settings-collection-count">{all.length} 个节点{preview ? ' · 只读预览' : ''}</span>
      <div className="flex items-center gap-2"><Button className="primary" disabled={preview} onClick={() => add('root')}><PlusIcon data-icon="inline-start" />新建节点</Button>
        <ActionMenu label="目录操作" icon={<MoreHorizontalIcon />} popupClassName="settings-collection-menu" items={[
          {id:'import',label:'导入目录…',disabled:preview,onSelect:()=>void store.run(async()=>{const result=await write('pickWebImport');if(!result.canceled){if(!result.items?.length)throw new Error('导入文件里没有网页节点');setPending(result);}})},
          {id:'expand',label:'全部展开',onSelect:()=>setExpanded(new Set(all.map(e=>e.node.id)))},
          {id:'collapse',label:'全部收起',onSelect:()=>setExpanded(new Set())}
        ]} />
      </div>
    </div>
    <div className="settings-collection grid" data-detail-open={pane.detailOpen} style={{ '--settings-tree-width': `${width}px` } as CSSProperties}>
      <aside className="settings-catalog-nav min-w-0" data-collection-list onFocusCapture={pane.onListFocus}>
        <div className="settings-catalog-search"><Input aria-label="筛选网页目录" type="search" placeholder="搜索目录或网页…" value={filter} onChange={e => setFilter(e.target.value)} /></div>
        <div className="settings-collection-list-meta flex flex-wrap items-center justify-between gap-2"><span>{deferred ? `匹配 ${visible.length} 项` : '全部节点'}</span><div className="flex items-center gap-1"><Button variant="ghost" size="sm" aria-pressed={selectionMode} onClick={()=>{setSelectionMode(!selectionMode);if(selectionMode)setSelected(activeIds.slice(0,1));}}>{selectionMode ? '结束多选' : '多选'}</Button><Help label="网页目录拖拽与多选">可使用多选按钮，或 ⌘ / Ctrl / Shift 点击多选。拖到行上方或下方调整顺序，拖到中央移入目录。</Help></div></div>
        {activeIds.length ? <Button className="settings-selection-review" onClick={()=>pane.openDetail()}>管理所选 {activeIds.length} 项</Button> : null}
        <div ref={view.ref} onScroll={view.capture} role="tree" aria-label="网页目录" aria-multiselectable="true" className="settings-tree">{visible.map(({ node: item, depth }) => <div key={item.id} role="treeitem" aria-level={depth + 1} aria-selected={selected.includes(item.id)} aria-expanded={item.children?.length ? expanded.has(item.id) : undefined} tabIndex={0} data-node-id={item.id} data-drop-position={dropTarget?.id===item.id?dropTarget.position:undefined} className={`settings-tree-row flex items-center ${depth === 0 ? 'settings-tree-root' : ''}`} style={{ paddingInlineStart: 10 + depth * 16 }} onClick={e => { if (Date.now() >= suppressClickUntil.current) select(item.id, e.metaKey || e.ctrlKey || e.shiftKey); }} onPointerDown={e => { if (!(e.target instanceof Element) || !e.target.closest('button,input,select,textarea')) beginPointerDrag(item.id, e); }} onKeyDown={e => { if(e.target!==e.currentTarget)return; if (['Enter', ' '].includes(e.key)) { e.preventDefault(); select(item.id, e.metaKey || e.ctrlKey || e.shiftKey); } if (e.key === 'ArrowRight') setExpanded(prev => new Set([...prev, item.id])); if (e.key === 'ArrowLeft') setExpanded(prev => { const next = new Set(prev); next.delete(item.id); return next; }); if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); const rows = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=treeitem]'); const index = visible.findIndex(n => n.node.id === item.id); rows?.[index + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); } }}>
          {item.children?.length ? <Button aria-label={`${expanded.has(item.id) ? '收起' : '展开'} ${item.title}`} className="settings-tree-toggle" onClick={e => { e.stopPropagation(); setExpanded(prev => { const next = new Set(prev); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; }); }}>{expanded.has(item.id) ? <FolderOpenIcon size={15} strokeWidth={1.8} aria-hidden="true" /> : <FolderIcon size={15} strokeWidth={1.8} aria-hidden="true" />}</Button> : <span className="settings-tree-leaf" aria-hidden="true">{item.url ? <Globe2Icon size={15} strokeWidth={1.8} /> : <FolderIcon size={15} strokeWidth={1.8} />}</span>}
          <span className="settings-tree-title truncate">{item.title || item.id}</span>
          <Button aria-label={`拖动 ${item.title || item.id}`} className="settings-drag-handle" onClick={e => e.stopPropagation()} onPointerDown={e => { e.preventDefault(); e.stopPropagation(); beginPointerDrag(item.id, e, true); }}>⠿</Button>
        </div>)}{!visible.length ? <CollectionEmpty title={deferred ? "没有匹配的目录" : "暂无网页目录"} icon={<FolderIcon />}>{deferred ? <Button onClick={()=>setFilter('')}>清除筛选</Button> : <Button disabled={preview} onClick={()=>add('root')}>新建节点</Button>}</CollectionEmpty> : null}</div>
      </aside>
      <div className="settings-divider" role="separator" tabIndex={0} aria-label="调整目录宽度" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={380} aria-valuenow={width} onPointerDown={e => { resizing.current = { x: e.clientX, width }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (resizing.current) resize(resizing.current.width + e.clientX - resizing.current.x); }} onPointerUp={() => { resizing.current = null; }} onPointerCancel={() => { resizing.current = null; }} onDoubleClick={() => resize(260)} onKeyDown={e => { const value = { ArrowLeft: width - 10, ArrowRight: width + 10, Home: 220, End: 380 }[e.key]; if (value !== undefined) { e.preventDefault(); resize(value); } }} />
      <div className="settings-catalog-detail min-w-0" data-collection-detail onFocusCapture={pane.onDetailFocus}>
        {activeIds.length > 1 ? <>
          <CollectionHeading title={`已选择 ${activeIds.length} 项`} location={`${selection.roots.length} 个独立分支 · 含子节点共 ${selection.count} 个节点`} icon={<ListChecksIcon />} onBack={()=>pane.back(activeIds[0],'data-node-id')} backLabel="返回网页列表" />
          <div className="settings-collection-bulk-actions flex flex-wrap gap-2"><Button disabled={preview} onClick={()=>prepareAction('move')}><MoveRightIcon data-icon="inline-start" />移动所选…</Button><Button variant="destructive" disabled={preview} onClick={()=>prepareAction('delete')}><Trash2Icon data-icon="inline-start" />删除所选…</Button></div>
          <ul className="settings-selection-list">{selection.roots.map(item=><li key={item.id}><FolderIcon aria-hidden="true" /><span>{path(item.id)}</span></li>)}</ul>
        </> : node ? <>
          <CollectionHeading title={node.title || '未命名节点'} location={`${node.url ? '网页' : '目录'} · ${byId.get(node.id)?.parent ? path(byId.get(node.id)!.parent!.id) : '根目录'}`} icon={node.url ? <Globe2Icon /> : <FolderIcon />} onBack={()=>pane.back(node.id,'data-node-id')} backLabel="返回网页列表">
            <ActionMenu label="节点操作" icon={<MoreHorizontalIcon />} popupClassName="settings-collection-menu" items={[
              {id:'child',label:'添加子节点',disabled:preview,onSelect:()=>add('child')},
              {id:'sibling',label:'添加同级节点',disabled:preview,onSelect:()=>add('sibling')},
              {id:'move',label:'移动到…',disabled:preview,onSelect:()=>prepareAction('move')},
              {id:'delete',label:'删除节点…',disabled:preview,onSelect:()=>prepareAction('delete')}
            ]} />
          </CollectionHeading>
          <FieldGroup className="settings-collection-fields" key={node.id}>
            {(['title','url','note'] as const).map((key,i)=><CollectionField key={key} label={['标题','页面链接','备注'][i]} value={node[key]} readOnly={preview} multiline={key==='note'} onChange={value=>store.edit(c=>{const target=entries(c.plugins.web.settings.items).find(e=>e.node.id===node.id);if(target)target.node[key]=value;},`web:${node.id}:${key}`)} help={key==='url'?'留空作为目录，填写后可直接打开，也可保留子节点。':undefined} />)}
            <details className="settings-collection-advanced"><summary>图标与高级属性</summary><FieldGroup className="pt-4">
              {(['icon','accent'] as const).map((key,i)=><CollectionField key={key} label={['图标（Emoji / 图片 URL）','强调色'][i]} value={node[key]} readOnly={preview} onChange={value=>store.edit(c=>{const target=entries(c.plugins.web.settings.items).find(e=>e.node.id===node.id);if(target)target.node[key]=value;},`web:${node.id}:${key}`)} />)}
              <div className="settings-catalog-metadata"><span>节点 ID</span><code>{node.id}</code><Help label="节点 ID说明">节点的内部唯一标识，用于保存、移动和关联。日常使用无需修改。</Help></div>
            </FieldGroup></details>
          </FieldGroup>
        </> : <CollectionEmpty title="选择一个目录或网页" icon={<FolderIcon />} onBack={()=>pane.back('','data-node-id')} backLabel="返回网页列表" />}
      </div>
    </div>
    {action ? <Dialog title={action.kind==='delete'?'删除节点':'移动节点'} busy={false} onClose={()=>setAction(null)} notice={actionError}>
      <p>{action.kind==='delete'?`将删除 ${action.titles.length} 个分支，共 ${action.count} 个节点（含 ${action.descendants} 个子节点）。保存前可撤销。`:`将移动 ${action.titles.length} 个分支，子节点保持原有层级。`}</p>
      <ul className="settings-confirm-list">{action.titles.map((title,i)=><li key={action.ids[i]}>{title}</li>)}</ul>
      {action.kind==='move'?<FieldGroup><Field><FieldLabel>目标目录</FieldLabel><Select label="目标目录" value={moveTarget} onChange={setMoveTarget} options={[{value:'root',label:'根目录'},...all.filter(entry=>!action.blocked.has(entry.node.id)&&(!entry.node.url || entry.node.children?.length)).map(entry=>({value:`node:${entry.node.id}`,label:path(entry.node.id)}))]} /></Field></FieldGroup>:null}
      <div className="settings-dialog-actions"><Button onClick={()=>setAction(null)}>取消</Button><Button variant={action.kind==='delete'?'destructive':'default'} disabled={Boolean(actionError)} onClick={applyAction}>{action.kind==='delete'?'确认删除':'确认移动'}</Button></div>
    </Dialog> : null}
    {pending && plan ? <Dialog title="核对目录导入" busy={false} onClose={() => setPending(null)}><p>{pending.path}</p><Choice label="重复 ID" value={overwrite} options={[{ value: 'skip', label: '跳过' }, { value: 'overwrite', label: '覆盖属性并合并子节点' }]} onChange={setOverwrite} /><pre className="settings-code">{plan.changes.join('\n')}</pre><Button onClick={() => { editNodes(plan.nodes); setPending(null); }}>应用为草稿</Button></Dialog> : null}
  </div>;
}
interface MemoDropTarget extends MemoMoveRef { position: MemoDropPosition }
interface MemoDragControls {
  target: MemoDropTarget | null;
  start: (entry: MemoMoveRef, transfer?: DataTransfer) => void;
  over: (row: HTMLElement, y: number) => boolean;
  drop: (row: HTMLElement, y: number) => void;
  clearTarget: () => void;
  end: () => void;
}
function MemoDragHandle({ entry, drag }: { entry: MemoMoveRef; drag: MemoDragControls }) {
  return <Button className="settings-memo-drag-handle" aria-label={'拖动' + (entry.kind === 'category' ? '分类 ' : '备忘 ') + entry.id} draggable={false} onClick={event => event.stopPropagation()} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); drag.start(entry); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-memo-kind]');
    if (row && event.currentTarget.closest('.settings-memo-tree')?.contains(row)) drag.over(row, event.clientY);
    else drag.clearTarget();
  }} onPointerUp={event => {
    event.stopPropagation();
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-memo-kind]');
    if (row && event.currentTarget.closest('.settings-memo-tree')?.contains(row)) drag.drop(row, event.clientY);
    drag.end();
  }} onPointerCancel={drag.end}>⠿</Button>;
}
function MemoTreeRow({ entry, depth, label, count, expanded, selected, onActivate, onSetOpen, drag }: {
  entry: MemoMoveRef; depth: number; label: string; count?: number; expanded?: boolean; selected?: boolean;
  onActivate: () => void; onSetOpen?: (open: boolean) => void; drag: MemoDragControls;
}) {
  const category = entry.kind === 'category';
  return <div role="treeitem" tabIndex={0} aria-level={depth} aria-expanded={category ? expanded : undefined} aria-selected={category ? undefined : selected} data-memo-kind={entry.kind} data-memo-key={entry.id} data-memo-category={category ? entry.id : undefined} data-drop-position={drag.target?.kind === entry.kind && drag.target.id === entry.id ? drag.target.position : undefined} className={'settings-memo-tree-row ' + (category ? 'settings-memo-category' : 'settings-memo-item')} style={{ paddingInlineStart: 10 + (depth - 1) * 16 }} draggable onClick={onActivate} onKeyDown={event => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onActivate(); }
    if (category && event.key === 'ArrowRight') { event.preventDefault(); onSetOpen?.(true); }
    if (category && event.key === 'ArrowLeft') { event.preventDefault(); onSetOpen?.(false); }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const rows = [...(event.currentTarget.closest('.settings-memo-tree')?.querySelectorAll<HTMLElement>('[role=treeitem]') || [])];
      rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    }
  }} onDragStart={event => drag.start(entry, event.dataTransfer)} onDragEnd={drag.end} onDragOver={event => { if (drag.over(event.currentTarget, event.clientY)) event.preventDefault(); }} onDrop={event => { event.preventDefault(); drag.drop(event.currentTarget, event.clientY); }}>
    {category ? <Button className="settings-memo-toggle" aria-label={(expanded ? '收起 ' : '展开 ') + label} onClick={event => { event.stopPropagation(); onActivate(); }}>{expanded ? <FolderOpenIcon size={15} strokeWidth={1.8} aria-hidden="true" /> : <FolderIcon size={15} strokeWidth={1.8} aria-hidden="true" />}</Button> : <span className="settings-memo-leaf" aria-hidden="true"><TerminalSquareIcon size={14} strokeWidth={1.8} /></span>}
    <span className="settings-memo-label">{label}</span>
    {category ? <span className="settings-memo-count">{count}</span> : null}
    <MemoDragHandle entry={entry} drag={drag} />
  </div>;
}
function MemoTreeView({ branch, depth, collapsed, forceOpen, selected, onSelect, onToggle, onSetOpen, drag }: {
  branch: MemoBranch; depth: number; collapsed: Set<string>; forceOpen: boolean; selected: string;
  onSelect: (id: string) => void; onToggle: (path: string) => void; onSetOpen: (path: string, open: boolean) => void; drag: MemoDragControls;
}) {
  return <>
    {branch.children.map(child => {
      const open = forceOpen || !collapsed.has(child.path);
      return <div key={child.path} className="settings-memo-branch">
        <MemoTreeRow entry={{ kind: 'category', id: child.path }} depth={depth} label={child.name} count={child.count} expanded={open} onActivate={() => onToggle(child.path)} onSetOpen={value => onSetOpen(child.path, value)} drag={drag} />
        {open ? <div role="group"><MemoTreeView branch={child} depth={depth + 1} collapsed={collapsed} forceOpen={forceOpen} selected={selected} onSelect={onSelect} onToggle={onToggle} onSetOpen={onSetOpen} drag={drag} /></div> : null}
      </div>;
    })}
    {branch.items.map(item => <MemoTreeRow key={item.id} entry={{ kind: 'item', id: item.id }} depth={depth} label={item.title} selected={selected === item.id} onActivate={() => onSelect(item.id)} drag={drag} />)}
  </>;
}
export function Memos({ store }: { store: SettingsStore }) {
  const s = useSettings(store), preview = readonly(), configured = s.config!.plugins.memo.settings.items;
  const defaults = useMemo(() => host().FlowHubMemoCatalog?.cloneDefaults() || [], []);
  const [previewItems, setPreviewItems] = useViewState<Memo[] | null>('memo:preview',null);
  const items: Memo[] = preview && previewItems ? previewItems : configured || defaults;
  const [selected, setSelected] = useViewState('memo:selected',''), [filter, setFilter] = useViewState('memo:filter',''), [collapsed, setCollapsed] = useViewState('memo:collapsed',()=>new Set<string>()), [category, setCategory] = useState<string | null>(null), [tags, setTags] = useState<string | null>(null), [confirm, setConfirm] = useState<{kind:'reset'|'delete';id:string;title:string;count:number;snapshot:string}|null>(null), [confirmError,setConfirmError] = useState('');
  const memoScroll=useViewScroll('memo:scroll');
  const pane=useCollectionPane('memo',memoScroll.ref);
  const dragging = useRef<MemoMoveRef | null>(null);
  const [dropTarget, setDropTarget] = useState<MemoDropTarget | null>(null);
  const deferred = useDeferredValue(filter).trim().toLowerCase();
  const allTree = useMemo(() => memoTree(items), [items]);
  const tree = useMemo(() => deferred ? memoTree(items.filter(item => [item.title, item.category, item.content, item.description, ...(Array.isArray(item.tags) ? item.tags : [])].join(' ').toLowerCase().includes(deferred))) : allTree, [allTree, items, deferred]);
  const categoryPaths = useMemo(() => {
    const paths = new Set<string>();
    const visit = (branch: MemoBranch) => branch.children.forEach(child => { paths.add(child.path); visit(child); });
    visit(allTree);
    return paths;
  }, [allTree]);
  const current = items.find(item => item.id === selected) || items[0];
  function selectMemo(id: string) { setSelected(id); setCategory(null); setTags(null);pane.openDetail(); }
  function edit(action: (items: Memo[]) => void, key?: string) { store.edit(c => { c.plugins.memo.settings.items ||= clone(defaults); action(c.plugins.memo.settings.items); }, key); }
  function finishDrag() { dragging.current = null; setDropTarget(null); }
  function dropAt(row: HTMLElement, y: number): MemoDropTarget | null {
    const source = dragging.current, kind = row.dataset.memoKind as MemoMoveRef['kind'], id = row.dataset.memoKey;
    if (!source || !id || !['category', 'item'].includes(kind) || source.kind === kind && source.id === id || source.kind === 'category' && kind === 'item') { setDropTarget(null); return null; }
    if (source.kind === 'category' && (id === source.id || id.startsWith(source.id + ' / '))) { setDropTarget(null); return null; }
    const ratio = (y - row.getBoundingClientRect().top) / row.getBoundingClientRect().height;
    const position: MemoDropPosition = source.kind === 'item' && kind === 'category' ? 'inside' : kind === 'item' ? ratio < .5 ? 'before' : 'after' : ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'inside';
    if (source.kind === 'category' && kind === 'category') {
      const parent = position === 'inside' ? id : id.split(' / ').slice(0, -1).join(' / ');
      const destination = [parent, source.id.split(' / ').at(-1)].filter(Boolean).join(' / ');
      if (destination !== source.id && categoryPaths.has(destination)) { setDropTarget(null); return null; }
    }
    const target = { kind, id, position };
    setDropTarget(previous => previous?.kind === kind && previous.id === id && previous.position === position ? previous : target);
    return target;
  }
  const drag: MemoDragControls = {
    target: dropTarget,
    start(entry, transfer) { dragging.current = entry; if (transfer) { transfer.setData('text/flowhub-memo', entry.kind + ':' + entry.id); transfer.effectAllowed = 'move'; } },
    over(row, y) { return Boolean(dropAt(row, y)); },
    drop(row, y) {
      const source = dragging.current, target = dropAt(row, y);
      if (source && target) {
        const next = moveMemo(items, source, target, target.position);
        if (next !== items) {
          if (preview) setPreviewItems(next);
          else store.edit(c => { c.plugins.memo.settings.items = next; });
          setCategory(null); setTags(null);
        }
      }
      finishDrag();
    },
    clearTarget() { setDropTarget(null); },
    end: finishDrag
  };
  function prepareConfirm(kind:'reset'|'delete') { setConfirm({kind,id:current?.id || '',title:current?.title || '',count:items.length,snapshot:JSON.stringify(items)});setConfirmError(''); }
  function addMemo() {
    const id='memo-'+crypto.randomUUID();edit(list=>list.push({id,title:'新备忘',category:'其他',content:'',tags:[]}));
    setFilter('');setSelected(id);setCategory(null);setTags(null);setCollapsed(previous=>{const next=new Set(previous);next.delete('其他');return next;});pane.openDetail(true);
  }
  return <div ref={pane.ref} className="settings-collection-page settings-memos">
    <div className="settings-collection-toolbar flex flex-wrap items-center justify-between gap-3"><span className="settings-collection-count">{items.length} 条 · {previewItems ? '临时预览' : configured ? '自定义库' : '内置命令库'}</span><div className="flex items-center gap-2"><Button className="primary" disabled={preview} onClick={addMemo}><PlusIcon data-icon="inline-start" />新增备忘</Button><ActionMenu label="备忘录操作" icon={<MoreHorizontalIcon />} popupClassName="settings-collection-menu" items={[
      {id:'expand',label:'全部展开',onSelect:()=>setCollapsed(new Set())},
      {id:'collapse',label:'全部收起',onSelect:()=>setCollapsed(new Set(tree.children.map(child=>child.path)))},
      {id:'reset',label:'恢复内置备忘录…',disabled:preview,onSelect:()=>prepareConfirm('reset')}
    ]} /></div></div>
    <div className="settings-memo-workspace grid" data-detail-open={pane.detailOpen}>
      <aside className="settings-memo-nav min-w-0" data-collection-list onFocusCapture={pane.onListFocus}>
        <div className="settings-memo-search"><Input aria-label="筛选备忘录" type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="搜索标题、分类或内容…" /></div>
        <div className="settings-collection-list-meta"><span>{deferred ? `匹配 ${tree.count} 条` : '全部分类'}</span></div>
        <div ref={memoScroll.ref} onScroll={memoScroll.onScroll} className="settings-memo-tree" role="tree" aria-label="备忘录分类">{!tree.children.length && !tree.items.length ? <CollectionEmpty title={deferred ? "没有匹配的备忘" : "暂无备忘录"} icon={<TerminalSquareIcon />}>{deferred ? <Button onClick={()=>setFilter('')}>清除筛选</Button> : null}</CollectionEmpty> : <MemoTreeView branch={tree} depth={1} collapsed={collapsed} forceOpen={Boolean(deferred)} selected={current?.id || ''} onSelect={selectMemo} onToggle={path => setCollapsed(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; })} onSetOpen={(path, open) => setCollapsed(previous => { const next = new Set(previous); if (open) next.delete(path); else next.add(path); return next; })} drag={drag} />}</div>
      </aside>
      <div className="settings-memo-detail min-w-0" data-collection-detail onFocusCapture={pane.onDetailFocus}>{current ? <>
        <CollectionHeading title={current.title || '未命名备忘'} location={current.category || '未分类'} icon={<TerminalSquareIcon />} onBack={()=>pane.back(current.id,'data-memo-key')} backLabel="返回备忘列表"><ActionMenu label="备忘操作" icon={<MoreHorizontalIcon />} popupClassName="settings-collection-menu" items={[{id:'delete',label:'删除备忘…',disabled:preview,onSelect:()=>prepareConfirm('delete')}]} /></CollectionHeading>
        <FieldGroup className="settings-collection-fields" key={current.id}>
          <CollectionField label="标题" value={current.title} readOnly={preview} onChange={value=>edit(list=>{const item=list.find(item=>item.id===current.id);if(item)item.title=value;},`memo:${current.id}:title`)} />
          {!preview ? <div onBlur={event=>{if(event.currentTarget.contains(event.relatedTarget as Node))return;if(category!==null && category!==current.category){const before=current.category || '';edit(list=>{const item=list.find(value=>value.id===current.id);if(!item)return;item.category=category;renameCategory(list,before,category,item.id);},`memo:${current.id}:category`);setCollapsed(previous=>new Set([...previous].map(path=>path===before || path.startsWith(before+' / ')?category+path.slice(before.length):path)));setCategory(null);}}}><CollectionField label="分类路径" value={category ?? current.category} readOnly={preview} onChange={setCategory} help="使用 / 分层；离开输入框时同步修改后代分类路径。" /></div> : null}
          <CollectionField label="命令或备忘内容" value={current.content} readOnly={preview} multiline code onChange={value=>edit(list=>{const item=list.find(item=>item.id===current.id);if(item)item.content=value;},`memo:${current.id}:content`)} />
          <details className="settings-collection-advanced"><summary>说明与搜索标签</summary><FieldGroup className="pt-4">
            <CollectionField label="说明" value={current.description} readOnly={preview} multiline onChange={value=>edit(list=>{const item=list.find(item=>item.id===current.id);if(item)item.description=value;},`memo:${current.id}:description`)} />
            <div onBlur={()=>{if(preview || tags===null)return;edit(list=>{const item=list.find(item=>item.id===current.id);if(item)item.tags=tags.split(/[,，]/).map(value=>value.trim()).filter(Boolean);},`memo:${current.id}:tags`);setTags(null);}}><CollectionField label="搜索标签" value={tags ?? (Array.isArray(current.tags)?current.tags.join(', '):current.tags || '')} readOnly={preview} onChange={setTags} help="使用逗号分隔多个标签。" /></div>
          </FieldGroup></details>
        </FieldGroup>
      </> : <CollectionEmpty title="暂无备忘录" icon={<TerminalSquareIcon />} onBack={()=>pane.back('','data-memo-key')} backLabel="返回备忘列表" />}</div>
    </div>
    {confirm ? <Dialog title={confirm.kind==='reset'?'恢复内置备忘录':'删除备忘'} busy={false} onClose={()=>setConfirm(null)} notice={confirmError}>
      <p>{confirm.kind==='reset'?`当前 ${confirm.count} 条自定义备忘将替换为内置库；保存前可撤销。`:`删除“${confirm.title}”？保存前可撤销。`}</p>
      <div className="settings-dialog-actions"><Button onClick={()=>setConfirm(null)}>取消</Button><Button variant="destructive" disabled={Boolean(confirmError)} onClick={()=>{
        const currentItems=store.snapshot().config!.plugins.memo.settings.items || defaults;
        if(JSON.stringify(currentItems)!==confirm.snapshot){setConfirmError('备忘录已变化，请关闭并重新选择后再试。');return;}
        if(confirm.kind==='reset')store.edit(c=>{delete c.plugins.memo.settings.items;});
        else {const index=items.findIndex(item=>item.id===confirm.id),nextId=(items[index+1] || items[index-1])?.id || '';edit(list=>{const target=list.findIndex(item=>item.id===confirm.id);if(target>=0)list.splice(target,1);});setSelected(nextId);pane.back(nextId,'data-memo-key');}
        setCategory(null);setTags(null);setConfirm(null);
      }}>{confirm.kind==='reset'?'确认恢复':'确认删除'}</Button></div>
    </Dialog> : null}
  </div>;
}
