import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Globe2Icon } from 'lucide-react';
import { Button, Dialog, Input } from '../shared/ui';
import { Textarea } from '../components/ui/textarea';
import { Select, Help } from '../shared/controls';
import { Choice, TextField } from './fields';
import { host, readonly, write } from './api';
import { clone, entries, importWeb, moveNodes, moveMemo, removeNodes, renameCategory, memoTree, type MemoBranch, type MemoMoveRef, type MemoDropPosition, type Bag, type Memo, type WebNode } from './model';
import { useTreeView } from './useTreeView';
import { SettingsStore, useSettings } from './store';

export function WebCatalog({ store }: { store: SettingsStore }) {
  const s = useSettings(store), preview = readonly(), sourceNodes: WebNode[] = s.config!.plugins.web.settings.items;
  const [previewNodes, setPreviewNodes] = useState<WebNode[] | null>(null);
  const nodes = preview && previewNodes ? previewNodes : sourceNodes;
  const [selected, setSelected] = useState<string[]>([]), [expanded, setExpanded] = useState<Set<string>>(() => new Set(nodes.map(n => n.id))), [filter, setFilter] = useState(''), [target, setTarget] = useState(''), [pending, setPending] = useState<Bag | null>(null), [overwrite, setOverwrite] = useState('skip'), [deleteOpen, setDeleteOpen] = useState(false), [pendingAdd, setPendingAdd] = useState('');
  const deferred = useDeferredValue(filter).trim().toLowerCase(), all = useMemo(() => entries(nodes), [nodes]);
  const node = all.find(e => e.node.id === selected[0])?.node;
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
    let moved = false;
    const rowAt = (x: number, y: number) => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-node-id]');
      return row && tree.contains(row) && row.dataset.nodeId !== source ? row : null;
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      if (stopPointerDrag.current === cleanup) stopPointerDrag.current = null;
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (!moved && Math.hypot(move.clientX - clientX, move.clientY - clientY) < 5) return;
      moved = true;
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
          editNodes(moveNodes(nodes, selected.includes(source) ? selected : [source], id, position));
          setExpanded(prev => new Set([...prev, id]));
        }
      }
      cleanup();
      setDropTarget(null);
    };
    const onCancel = () => { cleanup(); setDropTarget(null); };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    stopPointerDrag.current = cleanup;
  }
  useEffect(() => { if (s.webSelection) { setSelected([s.webSelection]); setExpanded(prev => new Set([...prev, ...all.filter(e => entries(e.node.children || []).some(child => child.node.id === s.webSelection)).map(e => e.node.id)])); } }, [s.webSelection]);
  const visible = useMemo(() => {
    const matched = new Set(all.filter(e => [e.node.title, e.node.url, e.node.note, e.node.id].join(' ').toLowerCase().includes(deferred)).map(e => e.node.id));
    const list: typeof all = [];
    const visit = (items: WebNode[], depth: number, parent: WebNode | null) => items.forEach(node => {
      if (deferred && !matched.has(node.id) && !entries(node.children || []).some(e => matched.has(e.node.id))) return;
      list.push({ node, depth, parent }); if (deferred || expanded.has(node.id)) visit(node.children || [], depth + 1, node);
    }); visit(nodes, 0, null); return list;
  }, [all, nodes, deferred, expanded]);
  const view = useTreeView(visible.map(e => e.node.id), selected[0] || '', deferred);
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
    editNodes(next); setSelected([id]); setPendingAdd(id);
  }
  function move(boundary: 'top' | 'up' | 'down' | 'bottom') {
    const context = all.find(e => e.node.id === node?.id); if (!context) return;
    const siblings = context.parent?.children || nodes, index = siblings.indexOf(context.node);
    const nextIndex = boundary === 'top' ? 0 : boundary === 'bottom' ? siblings.length - 1 : index + (boundary === 'up' ? -1 : 1);
    if (nextIndex < 0 || nextIndex >= siblings.length || nextIndex === index) return;
    editNodes(moveNodes(nodes, [context.node.id], siblings[nextIndex].id, nextIndex < index ? 'before' : 'after'));
  }
  function select(id: string, multi: boolean) { setSelected(prev => multi ? prev.includes(id) ? prev.filter(v => v !== id) : [id, ...prev] : [id]); }
  return <div className="settings-catalog">
    <div className="settings-catalog-toolbar">
      <div className="settings-catalog-toolbar-main"><Button className="primary" disabled={preview} onClick={() => add('root')}>＋ 添加节点</Button><Button disabled={preview || !node} onClick={() => add('child')}>添加子节点</Button><Button disabled={preview || !node} onClick={() => add('sibling')}>添加同级</Button>{pendingAdd ? <Button disabled={preview} onClick={() => { editNodes(removeNodes(nodes, [pendingAdd])); setPendingAdd(''); setSelected([]); }}>取消添加</Button> : null}<Button disabled={preview} onClick={() => void store.run(async () => { const result = await write('pickWebImport'); if (!result.canceled) { if (!result.items?.length) throw new Error('导入文件里没有网页节点'); setPending(result); } })}>导入…</Button></div>
      <div className="settings-catalog-toolbar-view"><Button onClick={() => setExpanded(new Set(all.map(e => e.node.id)))}>全部展开</Button><Button onClick={() => setExpanded(new Set())}>全部收起</Button></div>
    </div>
    <div className="settings-collection grid" style={{ '--settings-tree-width': `${width}px` } as CSSProperties}>
      <aside className="settings-catalog-nav min-w-0">
        <div className="settings-catalog-search"><Input aria-label="筛选网页目录" type="search" placeholder="搜索标题、域名或 ID" value={filter} onChange={e => setFilter(e.target.value)} /><span>{visible.length} 项</span></div>
        <div ref={view.ref} onScroll={view.capture} role="tree" aria-label="网页目录" aria-multiselectable="true" className="settings-tree">{visible.map(({ node: item, depth }) => <div key={item.id} role="treeitem" aria-level={depth + 1} aria-selected={selected.includes(item.id)} aria-expanded={item.children?.length ? expanded.has(item.id) : undefined} tabIndex={0} data-node-id={item.id} data-drop-position={dropTarget?.id===item.id?dropTarget.position:undefined} className={`settings-tree-row flex items-center ${depth === 0 ? 'settings-tree-root' : ''}`} style={{ paddingInlineStart: 10 + depth * 16 }} onClick={e => { if (Date.now() >= suppressClickUntil.current) select(item.id, e.metaKey || e.ctrlKey || e.shiftKey); }} onPointerDown={e => { if (!(e.target instanceof Element) || !e.target.closest('button,input,select,textarea')) beginPointerDrag(item.id, e); }} onKeyDown={e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); select(item.id, e.metaKey || e.ctrlKey || e.shiftKey); } if (e.key === 'ArrowRight') setExpanded(prev => new Set([...prev, item.id])); if (e.key === 'ArrowLeft') setExpanded(prev => { const next = new Set(prev); next.delete(item.id); return next; }); if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); const rows = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=treeitem]'); const index = visible.findIndex(n => n.node.id === item.id); rows?.[index + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); } }}>
          {item.children?.length ? <Button aria-label={`${expanded.has(item.id) ? '收起' : '展开'} ${item.title}`} className="settings-tree-toggle" onClick={e => { e.stopPropagation(); setExpanded(prev => { const next = new Set(prev); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; }); }}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m5.5 3.5 4.5 4.5-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg></Button> : <span className="settings-tree-leaf" aria-hidden="true">{item.url ? <Globe2Icon size={16} strokeWidth={1.8} /> : '·'}</span>}
          <span className="settings-tree-title truncate">{item.title || item.id}</span>
          <Button aria-label={`拖动 ${item.title || item.id}`} className="settings-drag-handle" onClick={e => e.stopPropagation()} onPointerDown={e => { e.preventDefault(); e.stopPropagation(); beginPointerDrag(item.id, e, true); }}>⠿</Button>
        </div>)}{!visible.length ? <p className="settings-tree-empty">没有匹配的目录</p> : null}</div>
      </aside>
      <div className="settings-divider" role="separator" tabIndex={0} aria-label="调整目录宽度" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={380} aria-valuenow={width} onPointerDown={e => { resizing.current = { x: e.clientX, width }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (resizing.current) resize(resizing.current.width + e.clientX - resizing.current.x); }} onPointerUp={() => { resizing.current = null; }} onPointerCancel={() => { resizing.current = null; }} onDoubleClick={() => resize(260)} onKeyDown={e => { const value = { ArrowLeft: width - 10, ArrowRight: width + 10, Home: 220, End: 380 }[e.key]; if (value !== undefined) { e.preventDefault(); resize(value); } }} />
      <div className="settings-catalog-detail min-w-0">
        {node ? <><header className="settings-catalog-detail-head"><div><span>节点详情</span><h2>{selected.length > 1 ? `已选择 ${selected.length} 项` : node.title || node.id}</h2></div><Help label="目录排序与多选">⌘ / Ctrl / Shift 点击多选。拖到行上方或下方排序，中央作为子节点；也可使用移动目标和排序按钮。</Help></header>
          <div className="settings-catalog-actions"><div className="settings-catalog-order">{(['top', 'up', 'down', 'bottom'] as const).map((id, i) => <Button key={id} onClick={() => move(id)}>{['置顶', '上移', '下移', '置底'][i]}</Button>)}</div><Button className="settings-catalog-delete" disabled={preview} onClick={() => setDeleteOpen(true)}>删除{selected.length > 1 ? ` ${selected.length} 项` : ''}</Button></div>
          <div className="settings-catalog-move"><Select label="移动目标" value={target} options={[{ value: '', label: '根目录' }, ...all.filter(e => !selected.includes(e.node.id)).map(e => ({ value: e.node.id, label: `${'　'.repeat(e.depth)}${e.node.title || e.node.id}` }))]} onChange={setTarget} /><Button onClick={() => editNodes(moveNodes(nodes, selected, target))}>移动所选</Button></div>
          <div className="settings-catalog-fields">{(['title', 'id', 'url', 'icon', 'accent', 'note'] as const).map((key, i) => <TextField key={key} label={['标题', '节点 ID', '页面链接', '图标（Emoji / 图片 URL）', '强调色', '备注'][i]} value={node[key]} readOnly={preview || key === 'id'} onChange={v => store.edit(c => { const target = entries(c.plugins.web.settings.items).find(e => e.node.id === node.id); if (target) target.node[key] = v; })} help={key === 'url' ? '留空作为目录，填写后可直接打开，也可保留子节点。' : undefined} />)}</div>
        </> : <div className="settings-catalog-empty"><span aria-hidden="true">↖</span><strong>选择一个目录或网页</strong><p>在左侧查看结构与节点属性。</p></div>}
      </div>
    </div>
    {deleteOpen ? <Dialog title="删除节点" busy={false} onClose={() => setDeleteOpen(false)}><p>删除选中的 {selected.length} 个节点及其子节点？保存前可撤销。</p><Button onClick={() => { editNodes(removeNodes(nodes, selected)); setSelected([]); setDeleteOpen(false); }}>确认删除</Button></Dialog> : null}
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
  return <div role="treeitem" tabIndex={0} aria-level={depth} aria-expanded={category ? expanded : undefined} aria-selected={category ? undefined : selected} data-memo-kind={entry.kind} data-memo-key={entry.id} data-memo-category={category ? entry.id : undefined} data-drop-position={drag.target?.kind === entry.kind && drag.target.id === entry.id ? drag.target.position : undefined} className={'settings-memo-tree-row ' + (category ? 'settings-memo-category' : 'settings-memo-item')} style={{ paddingInlineStart: 8 + (depth - 1) * 16 }} draggable onClick={onActivate} onKeyDown={event => {
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
    {category ? <Button className="settings-memo-toggle" aria-label={(expanded ? '收起 ' : '展开 ') + label} onClick={event => { event.stopPropagation(); onActivate(); }}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m5.5 3.5 4.5 4.5-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></Button> : <span className="settings-memo-leaf" aria-hidden="true">·</span>}
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
  const [previewItems, setPreviewItems] = useState<Memo[] | null>(null);
  const items: Memo[] = preview && previewItems ? previewItems : configured || defaults;
  const [selected, setSelected] = useState(''), [filter, setFilter] = useState(''), [collapsed, setCollapsed] = useState(new Set<string>()), [category, setCategory] = useState<string | null>(null), [tags, setTags] = useState<string | null>(null), [confirm, setConfirm] = useState<'reset' | 'delete' | null>(null);
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
  function selectMemo(id: string) { setSelected(id); setCategory(null); setTags(null); }
  function edit(action: (items: Memo[]) => void) { store.edit(c => { c.plugins.memo.settings.items ||= clone(defaults); action(c.plugins.memo.settings.items); }); }
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
  return <>
    <div className="settings-memo-toolbar"><div><strong>命令备忘录</strong><span>{items.length} 条 · {previewItems ? '临时预览' : configured ? '自定义库' : '内置命令库'}</span></div><div className="flex gap-2"><Button disabled={preview} onClick={() => { const id = 'memo-' + crypto.randomUUID(); edit(list => list.push({ id, title: '新备忘', category: '其他', content: '', tags: [] })); setSelected(id); }}>新增备忘</Button><Button disabled={preview} onClick={() => setConfirm('reset')}>恢复内置</Button></div></div>
    <div className="settings-memo-workspace">
      <aside className="settings-memo-nav">
        <div className="settings-memo-search"><Input aria-label="筛选备忘录" value={filter} onChange={event => setFilter(event.target.value)} placeholder="搜索备忘…" /><Button onClick={() => setCollapsed(new Set())}>展开</Button><Button onClick={() => setCollapsed(new Set(tree.children.map(child => child.path)))}>收起</Button></div>
        <div className="settings-memo-tree" role="tree" aria-label="备忘录分类"><MemoTreeView branch={tree} depth={1} collapsed={collapsed} forceOpen={Boolean(deferred)} selected={current?.id || ''} onSelect={selectMemo} onToggle={path => setCollapsed(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; })} onSetOpen={(path, open) => setCollapsed(previous => { const next = new Set(previous); if (open) next.delete(path); else next.add(path); return next; })} drag={drag} /></div>
      </aside>
      <div className="settings-memo-detail min-w-0">{current ? <>
        <TextField label="标题" value={current.title} readOnly={preview} onChange={value => edit(list => { list.find(item => item.id === current.id)!.title = value; })} />
        <div onBlur={event => { if (preview || event.currentTarget.contains(event.relatedTarget as Node)) return; if (category !== null && category !== current.category) { const before = current.category || ''; edit(list => { const item = list.find(value => value.id === current.id)!; item.category = category; renameCategory(list, before, category, item.id); }); setCollapsed(previous => new Set([...previous].map(path => path === before || path.startsWith(before + ' / ') ? category + path.slice(before.length) : path))); setCategory(null); } }}>
          <TextField label="分类路径" value={category ?? current.category} readOnly={preview} onChange={setCategory} help="使用 / 分层；离开输入框时同步修改后代分类路径。" />
        </div>
        <label className="grid gap-2">命令或备忘内容<Textarea className="settings-code" rows={12} spellCheck={false} readOnly={preview} value={current.content || ''} onChange={event => edit(list => { list.find(item => item.id === current.id)!.content = event.target.value; })} /></label>
        <TextField label="说明" value={current.description} readOnly={preview} onChange={value => edit(list => { list.find(item => item.id === current.id)!.description = value; })} />
        <div onBlur={() => { if (preview) return; if (tags !== null) { edit(list => { list.find(item => item.id === current.id)!.tags = tags.split(/[,，]/).map(value => value.trim()).filter(Boolean); }); setTags(null); } }}><TextField label="搜索标签" value={tags ?? (Array.isArray(current.tags) ? current.tags.join(', ') : current.tags || '')} readOnly={preview} onChange={setTags} /></div>
        <Button disabled={preview} onClick={() => setConfirm('delete')}>删除备忘</Button>
      </> : <p>暂无备忘录</p>}</div>
    </div>
    {confirm ? <Dialog title={confirm === 'reset' ? '恢复内置备忘录' : '删除备忘'} busy={false} onClose={() => setConfirm(null)}><p>{confirm === 'reset' ? '当前自定义备忘录将替换为内置库；保存前可撤销。' : '删除当前备忘录？保存前可撤销。'}</p><Button onClick={() => { if (confirm === 'reset') store.edit(c => { delete c.plugins.memo.settings.items; }); else if (current) edit(list => { const index = list.findIndex(item => item.id === current.id); if (index >= 0) list.splice(index, 1); }); setConfirm(null); }}>确认</Button></Dialog> : null}
  </>;
}
