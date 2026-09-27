import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVerticalIcon, Settings2Icon } from 'lucide-react';
import { Button, Dialog, Input } from '../shared/ui';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { EmptyState, Help, Select, Switch } from '../shared/controls';
import { nativeHost } from '../shared/native';
import { WidgetSurface } from './WidgetSurface';
import { host, initialLayout, isLayout, minimum, normalize, cardConfig, type Card, type Config, type FrameHandle, type Invoke, type Layout, type Point, type Source } from './model';

type Editor = { boardId: string; card?: Card };
type Menu = { card: Card; x: number; y: number; pointer: boolean };
type Gesture = { id: string; pointer: number; node: HTMLElement; resize: boolean; origin: Point; left: number; top: number; width: number; height: number; moved: boolean; wanted?: Point; target: string | null; grown: number };

function EditorDialog({ editor, sources, invoke, preview, onClose, onSave }: {
  editor: Editor; sources: Source[]; invoke?: Invoke; preview: string | null;
  onClose(): void; onSave(plugin: string, title: string, config: Config): void;
}) {
  const [plugin, setPlugin] = useState(editor.card?.plugin || ''), [title, setTitle] = useState(editor.card?.title || '');
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const handle = useRef<FrameHandle | null>(null), saving = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const source = sources.find(source => source.id === plugin && source.widget);
  return <Dialog title={editor.card ? '编辑组件' : '添加组件'} onClose={onClose} busy={busy} notice={error} className="canvas-editor-dialog">
    <form id="widgetForm" className="grid gap-3" onSubmit={async event => {
      event.preventDefault(); const current = handle.current;
      if (!current || !ready || saving.current) return;
      saving.current = true; setBusy(true); setError('');
      try {
        const config = await current.save();
        if (!alive.current || current !== handle.current) return;
        onSave(plugin, title.trim(), config);
      } catch (error) { if (alive.current && current === handle.current) setError(String(error)); }
      finally { saving.current = false; if (alive.current) setBusy(false); }
    }}>
      <FieldGroup className="gap-3">
        <Field data-disabled={busy}><FieldLabel htmlFor="source">插件</FieldLabel><Select id="source" label="插件" value={plugin} disabled={busy} options={[{ value: '', label: '请选择插件', disabled: true }, ...sources.filter(source => source.widget).map(source => ({ value: source.id, label: source.title }))]}
          onChange={value => { handle.current = null; setReady(false); setError(''); setPlugin(value); }} /></Field>
        {source ? <Field data-disabled={busy}><FieldLabel htmlFor="cardTitle">卡片名称</FieldLabel><Input id="cardTitle" value={title} maxLength={60} disabled={busy} placeholder="默认使用插件名称" onChange={event => setTitle(event.target.value)} /></Field> : null}
      </FieldGroup>
      {source ? <>
        <WidgetSurface key={plugin} kind="editor" source={source} card={editor.card?.plugin === plugin ? editor.card : undefined} invoke={invoke} preview={preview}
          onEditor={(value, isReady) => { handle.current = value; setReady(isReady); }} />
        {!ready ? <p role="status">等待插件编辑器就绪…</p> : null}
        <Button type="submit" className="primary" disabled={!ready || busy}>{busy ? '保存中…' : editor.card ? '保存修改' : '添加到画布'}</Button>
      </> : null}
    </form>
  </Dialog>;
}

export function Canvas() {
  const invoke = nativeHost()?.core?.invoke, preview = new URLSearchParams(location.search).get('preview');
  const [layout, setLayout] = useState(initialLayout), layoutRef = useRef(layout);
  const [sources, setSources] = useState<Source[]>([]), sourcesRef = useRef(sources);
  const [notice, setNotice] = useState(''), [loaded, setLoaded] = useState(false), [inactive, setInactive] = useState(false);
  const [viewOnlyBusy, setViewOnlyBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null), [naming, setNaming] = useState<'new' | 'rename' | null>(null), [name, setName] = useState(''), [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const canvas = useRef<HTMLElement>(null), toolbar = useRef<HTMLElement>(null), menuNode = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null), suppressClick = useRef(0), saving = useRef(0), saveTail = useRef(Promise.resolve());
  const fitted = useRef(''), alive = useRef(true);
  const board = layout.boards.find(board => board.id === layout.active)!;
  const viewOnly = layout.viewOnly === true;
  const width = Math.max(320, ...board.cards.map(card => (card.x || 0) + (card.width || 184)));
  const height = Math.max(120, ...board.cards.map(card => (card.y || 0) + (card.height || 184)));
  const current = useRef({ editor, naming, deleting, menu }); current.current = { editor, naming, deleting, menu };
  const modalOpen = () => !!(current.current.editor || current.current.naming || current.current.deleting);
  const api = <T = unknown,>(action: string, payload: unknown = {}) => invoke!<T>('plugin_canvas_api', { action, payload });
  function fitSurface() {
    if (!invoke || gesture.current || modalOpen() || !canvas.current || !toolbar.current) return;
    const width = Math.max(360, canvas.current.offsetWidth + 32, toolbar.current.scrollWidth + 32);
    const height = canvas.current.offsetTop + canvas.current.offsetHeight + 16, key = `${width}:${height}`;
    if (key === fitted.current) return;
    fitted.current = key; void api('fit', { width, height }).catch(() => { fitted.current = ''; });
  }
  function commit(change: (draft: Layout) => void, moving?: string, wanted?: Point, target?: string | null) {
    if (layoutRef.current.viewOnly) return;
    const draft = structuredClone(layoutRef.current); change(draft);
    const next = normalize(draft, sourcesRef.current, moving, wanted, target);
    layoutRef.current = next; setLayout(next); setMenu(null);
    // Each queued write owns an immutable snapshot; failures do not block later writes.
    const snapshot = structuredClone(next); saving.current++;
    saveTail.current = saveTail.current.catch(() => {}).then(async () => {
      try {
        if (invoke) await api('save', snapshot);
        else localStorage.setItem('flowhub-canvas-preview', JSON.stringify(snapshot));
        if (alive.current && invoke) setNotice('');
      } catch (error) { if (alive.current) setNotice(`保存失败：${error}`); }
      finally { saving.current--; }
    });
  }
  const changeCards = (change: (cards: Card[]) => void) => commit(draft => change(draft.boards.find(board => board.id === draft.active)!.cards));
  function add(card?: Card) {
    if (layoutRef.current.viewOnly) return;
    if (!sourcesRef.current.some(source => source.widget)) { setNotice('请先安装或升级提供组件页面的插件'); return; }
    const active = layoutRef.current.boards.find(board => board.id === layoutRef.current.active)!;
    if (!card && active.cards.length >= 32) { setNotice('每个布局最多 32 个组件'); return; }
    setMenu(null); setEditor({ boardId: active.id, card });
    if (invoke) void api('fit', { width: Math.max(innerWidth, 360), height: Math.max(innerHeight, 560) }).catch(() => {});
  }
  function openCard(card: Card, selection?: Config) {
    if (layoutRef.current.viewOnly) return;
    const title = card.title || sourcesRef.current.find(source => source.id === card.plugin)?.title || '插件详情';
    const config = { ...cardConfig(card), ...(selection ? { selection } : {}) };
    if (invoke) void api('detail', { plugin: card.plugin, config, title }).catch(error => setNotice(String(error)));
    else location.href = 'plugin-detail.html?' + new URLSearchParams({ ...(preview ? { preview } : {}), config: JSON.stringify(config), title });
  }
  async function changeViewOnly(enabled: boolean) {
    if (!invoke || viewOnlyBusy || !loaded) return;
    setViewOnlyBusy(true);
    try {
      await api('setViewOnly', { enabled });
      window.dispatchEvent(new CustomEvent('flowhub:canvas-view-only', { detail: enabled }));
      setNotice('');
    } catch (error) { setNotice(`切换仅查看模式失败：${error}`); }
    finally { setViewOnlyBusy(false); }
  }
  const actions = useRef({ fitSurface, openCard, add }); actions.current = { fitSurface, openCard, add };
  useEffect(() => {
    alive.current = true; let stopped = false, request = 0, initialized = false;
    document.body.classList.toggle('preview', !invoke);
    async function load(initial = false) {
      initial = initial || !initialized;
      if (stopped || saving.current || gesture.current || (!initial && (modalOpen() || current.current.menu))) return;
      const sequence = ++request;
      try {
        let nextSources = sourcesRef.current, nextLayout = layoutRef.current;
        if (invoke) {
          const data = await invoke<{ layout: Layout; sources: Source[] }>('plugin_canvas_api', { action: 'get', payload: {} });
          if (initial) nextLayout = data.layout; nextSources = data.sources;
        } else if (initial) {
          try { const stored: unknown = JSON.parse(localStorage.getItem('flowhub-canvas-preview') || 'null'); if (isLayout(stored)) nextLayout = stored; } catch { /* Preview storage is optional. */ }
          if (preview) { const response = await fetch(new URL('widget-preview.json', preview)); if (!response.ok) throw Error('插件预览无法加载'); nextSources = [await response.json() as Source]; }
        }
        if (stopped || sequence !== request || saving.current || gesture.current || (!initial && (modalOpen() || current.current.menu))) return;
        // A user mutation may have finished while the snapshot request was in flight.
        if (!initial) nextLayout = layoutRef.current;
        if (!isLayout(nextLayout)) throw Error('组件布局无效');
        sourcesRef.current = nextSources; setSources(nextSources);
        const normalized = normalize(nextLayout, nextSources); layoutRef.current = normalized; setLayout(normalized);
        if (!invoke) setNotice(preview ? '浏览器预览只读 · 插件模拟数据；布局仅保存在浏览器' : '浏览器预览只读 · 使用 ?preview=插件预览地址 加载组件');
        else setNotice('');
        initialized = true; setLoaded(true);
      } catch (error) { if (!stopped) setNotice(String(error)); }
    }
    void load(true);
    // The desktop canvas may remain on screen while its WebView is considered
    // hidden. Keep snapshots fresh, and catch up immediately after a suspension.
    const interval = window.setInterval(() => { void load(); }, 15000);
    const onVisibilityChange = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => { stopped = true; alive.current = false; clearInterval(interval); document.removeEventListener('visibilitychange', onVisibilityChange); document.body.classList.remove('preview'); };
  }, [invoke, preview]);
  useEffect(() => { fitted.current = ''; const frame = requestAnimationFrame(() => actions.current.fitSurface()); return () => cancelAnimationFrame(frame); }, [width, height, editor, naming, deleting, loaded, viewOnly]);
  useEffect(() => {
    const change = (event: Event) => {
      const enabled = (event as CustomEvent<boolean>).detail;
      if (typeof enabled !== 'boolean') return;
      if (enabled && gesture.current) {
        const g = gesture.current;
        gesture.current = null;
        Object.assign(g.node.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
        g.node.classList.remove('moving');
        canvas.current?.querySelectorAll('.swap-target').forEach(node => node.classList.remove('swap-target'));
        if (g.node.hasPointerCapture(g.pointer)) g.node.releasePointerCapture(g.pointer);
      }
      const next = { ...layoutRef.current, viewOnly: enabled };
      layoutRef.current = next; setLayout(next); setMenu(null); setEditor(null); setNaming(null); setDeleting(false);
    };
    window.addEventListener('flowhub:canvas-view-only', change);
    return () => window.removeEventListener('flowhub:canvas-view-only', change);
  }, []);

  // One native cursor poll owns surface exit and menu tracking, including iframe crossings.
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, leaveTimer: ReturnType<typeof setTimeout> | undefined, revision = 0;
    const cancelLeave = () => { clearTimeout(leaveTimer); leaveTimer = undefined; };
    const close = () => { cancelLeave(); setMenu(null); };
    function trackMenu(x: number, y: number) {
      const active = current.current.menu; if (!active?.pointer) return;
      const card = [...(canvas.current?.querySelectorAll<HTMLElement>('[data-id]') || [])].find(node => node.dataset.id === active.card.id);
      const contains = (node?: HTMLElement | null) => { if (!node?.isConnected) return false; const r = node.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; };
      if (contains(menuNode.current) || contains(card)) cancelLeave();
      else if (!leaveTimer) leaveTimer = setTimeout(() => { leaveTimer = undefined; if (current.current.menu === active) close(); }, 180);
    }
    function track(x: number, y: number, frontmost = true) {
      const inside = frontmost && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
      setInactive(!inside);
      if (!inside) { close(); setEditor(null); setNaming(null); setDeleting(false); }
      trackMenu(x, y);
    }
    async function poll() {
      const generation = revision;
      try { const p = await invoke!<Point & { frontmost?: boolean }>('plugin_canvas_api', { action: 'cursor', payload: {} }); if (!stopped && generation === revision) track(p.x, p.y, p.frontmost !== false); } catch { /* A closing window may reject cursor IPC. */ }
      if (!stopped) timer = setTimeout(poll, 150);
    }
    const move = (event: PointerEvent | MouseEvent) => { revision++; track(event.clientX, event.clientY); };
    const down = (event: PointerEvent) => { if (!menuNode.current?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const leave = () => { close(); if (!invoke) { revision++; track(-1, -1); } };
    const hide = () => { stopped = true; revision++; clearTimeout(timer); close(); };
    const show = () => { if (stopped) { stopped = false; if (invoke) void poll(); } };
    const visibility = () => { if (document.hidden) close(); };
    const blur = (event: FocusEvent) => { if (!(event.relatedTarget instanceof Node) || !document.contains(event.relatedTarget)) close(); };
    const focus = (event: FocusEvent) => { const node = event.target as Element; if (!menuNode.current?.contains(node) && node.closest?.('[data-id]')?.getAttribute('data-id') !== current.current.menu?.card.id) close(); };
    const scroll = (event: Event) => { if (!menuNode.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointermove', move, true); document.addEventListener('mousemove', move, true);
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key);
    document.documentElement.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', visibility); document.addEventListener('focusin', focus); document.addEventListener('scroll', scroll, true);
    window.addEventListener('blur', blur); window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    if (invoke) void poll();
    return () => {
      stopped = true; clearTimeout(timer); cancelLeave();
      document.removeEventListener('pointermove', move, true); document.removeEventListener('mousemove', move, true);
      document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key);
      document.documentElement.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('focusin', focus); document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('blur', blur); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
    };
  }, [invoke]);
  useEffect(() => { if (menu) menuNode.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [menu]);

  function start(event: ReactPointerEvent<HTMLElement>, card: Card) {
    if (layoutRef.current.viewOnly || event.button !== 0) return;
    const target = event.target as Element, resize = !!target.closest('[data-resize]');
    if (!resize && target.closest('button,input,select')) return;
    const node = event.currentTarget;
    gesture.current = { id: card.id, pointer: event.pointerId, node, resize, origin: { x: event.clientX, y: event.clientY }, left: card.x || 0, top: card.y || 0, width: card.width!, height: card.height!, moved: false, target: null, grown: 0 };
    node.setPointerCapture(event.pointerId); event.preventDefault();
  }
  function move(event: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current; if (!g || g.pointer !== event.pointerId) return;
    const dx = event.clientX - g.origin.x, dy = event.clientY - g.origin.y;
    if (Math.abs(dx) + Math.abs(dy) < 4 && !g.moved) return;
    g.moved = true;
    const cards = layoutRef.current.boards.find(board => board.id === layoutRef.current.active)!.cards;
    if (g.resize) {
      const min = minimum(cards.find(card => card.id === g.id)!, sourcesRef.current);
      g.node.style.width = `${Math.round(Math.max(min.width, Math.min(1600, g.width + dx)))}px`;
      g.node.style.height = `${Math.round(Math.max(min.height, Math.min(1200, g.height + dy)))}px`;
    } else {
      g.node.classList.add('moving'); g.wanted = { x: Math.max(0, g.left + dx), y: Math.max(0, g.top + dy) };
      g.node.style.left = `${g.wanted.x}px`; g.node.style.top = `${g.wanted.y}px`;
      const rect = canvas.current!.getBoundingClientRect();
      g.target = host().WidgetLayout.swapTarget(cards, g.id, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      canvas.current!.querySelectorAll<HTMLElement>('[data-id]').forEach(node => node.classList.toggle('swap-target', node.dataset.id === g.target));
      if (invoke && Date.now() - g.grown > 150 && (event.clientX > innerWidth - 40 || event.clientY > innerHeight - 40)) {
        g.grown = Date.now(); fitted.current = '';
        void api('fit', { width: innerWidth + (event.clientX > innerWidth - 40 ? 160 : 0), height: innerHeight + (event.clientY > innerHeight - 40 ? 140 : 0) }).catch(() => {});
      }
    }
  }
  function finish(event: ReactPointerEvent<HTMLElement>, cancel = false) {
    const g = gesture.current; if (!g || g.pointer !== event.pointerId) return;
    gesture.current = null;
    const resized = { width: parseInt(g.node.style.width), height: parseInt(g.node.style.height) };
    // Restore transient styles before React's committed geometry takes ownership.
    Object.assign(g.node.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
    g.node.classList.remove('moving'); canvas.current?.querySelectorAll('.swap-target').forEach(node => node.classList.remove('swap-target'));
    if (g.node.hasPointerCapture(event.pointerId)) g.node.releasePointerCapture(event.pointerId);
    if (g.moved) suppressClick.current = Date.now() + 150;
    if (!cancel && g.moved) {
      if (g.resize) changeCards(cards => Object.assign(cards.find(card => card.id === g.id)!, resized));
      else commit(() => {}, g.id, g.wanted, g.target);
    }
    fitted.current = ''; requestAnimationFrame(() => actions.current.fitSurface());
  }
  const context = (card: Card, x: number, y: number, pointer = true) => setMenu({ card, x: Math.max(8, Math.min(x, innerWidth - 176)), y: Math.max(8, Math.min(y, innerHeight - 150)), pointer });
  return <div className="fh-canvas-app" data-view-only={viewOnly}>
    <header ref={toolbar} className={`canvas-toolbar flex flex-wrap items-center gap-2 ${inactive ? 'surface-inactive' : ''}`} inert={inactive || viewOnly}>
      <Button id="dragSurface" className="brand" size="icon" aria-label="拖动桌面组件区域" title="拖动桌面组件区域" disabled={!invoke} onMouseDown={event => { if (event.button === 0 && invoke) void api('drag').catch(error => setNotice(String(error))); }}><GripVerticalIcon aria-hidden="true" /></Button>
      <Select id="boards" label="切换组件布局" value={layout.active} disabled={!loaded} options={layout.boards.map(board => ({ value: board.id, label: board.title }))} onChange={value => commit(draft => { draft.active = value; })} />
      <div className="flex items-center gap-1"><Switch label="置顶" checked={layout.pinned} disabled={!loaded} onChange={value => commit(draft => { draft.pinned = value; })} /><span>置顶</span></div>
      <div className="flex items-center gap-1" title="开启后组件只供查看；需在 FlowHub 设置中关闭"><Switch label="仅查看桌面组件" checked={viewOnly} disabled={!loaded || !invoke || viewOnlyBusy} onChange={value => { void changeViewOnly(value); }} /><span>仅查看</span></div>
      <Button id="add" className="primary" disabled={!loaded || board.cards.length >= 32} onClick={() => add()}>＋ 添加组件</Button>
      <Button id="newBoard" disabled={!loaded || layout.boards.length >= 12} onClick={() => { setName(''); setNaming('new'); }}>＋ 布局</Button>
      <Button id="rename" disabled={!loaded} onClick={() => { setName(board.title); setNaming('rename'); }}>重命名</Button>
      <Button id="removeBoard" disabled={!loaded || layout.boards.length < 2} onClick={() => setDeleting(true)}>删除布局</Button>
      <Button id="canvasSettings" size="icon" aria-label="打开桌面组件设置" title="打开桌面组件设置" disabled={!invoke} onClick={() => { if (invoke) void api('settings').catch(error => setNotice(String(error))); }}><Settings2Icon aria-hidden="true" /></Button>
      <Help label="画布操作说明">拖动卡片调整位置，边角缩放，方向键微调大小，右键编辑。每 15 秒更新插件缓存。</Help>
      <Button id="closeSurface" aria-label="关闭组件区域" disabled={!invoke} onClick={() => { if (invoke) void api('close').catch(error => setNotice(String(error))); }}>×</Button>
    </header>
    <p id="notice" role="status">{notice}</p>
    <main ref={canvas} id="canvas" aria-label="插件画布" className="relative" style={{ width, height }} onDragStart={event => event.preventDefault()}>
      {board.cards.map(card => {
        const source = sources.find(source => source.id === card.plugin), title = card.title || source?.title || card.plugin, interactive = source?.widget?.interactive === true;
        return <article key={`${board.id}:${card.id}`} data-id={card.id} tabIndex={viewOnly ? -1 : 0} className={`canvas-card absolute overflow-hidden ${interactive ? 'interactive' : ''}`} aria-label={`${title}，${viewOnly ? '仅查看' : interactive ? '顶部拖动或右键编辑，列表可操作' : '点击打开详情，右键编辑'}`}
          style={{ left: card.x, top: card.y, width: card.width, height: card.height }}
          onPointerDown={event => start(event, card)} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
          onClick={event => { if (viewOnly || Date.now() < suppressClick.current || (event.target as Element).closest('button')) return; openCard(card); }}
          onContextMenu={event => { event.preventDefault(); if (!viewOnly) context(card, event.clientX, event.clientY); }}
          onKeyDown={event => {
            if (viewOnly || event.target !== event.currentTarget) return;
            if (event.key === 'Enter') { event.preventDefault(); openCard(card); }
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); context(card, rect.left + 20, rect.top + 20, false); }
          }}>
          {source?.widget ? <WidgetSurface source={source} card={card} kind="card" invoke={invoke} preview={preview} inactive={viewOnly} onNavigate={(action, selection) => { if (layoutRef.current.viewOnly) return; const current = layoutRef.current.boards.find(board => board.id === layoutRef.current.active)?.cards.find(item => item.id === card.id); if (current) { if (action === 'detail') actions.current.openCard(current, selection); else if (action === 'editor') actions.current.add(current); } }} /> : <EmptyState>插件未启用或尚未提供组件页面 · 布局已保留</EmptyState>}
          <div className="widget-hit absolute" aria-hidden="true">{interactive ? '⠿' : ''}</div>
          <Button className="resize-handle absolute" data-resize aria-label="调整组件大小" onKeyDown={event => {
            if (layoutRef.current.viewOnly) return;
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation(); const min = minimum(card, sources);
            changeCards(cards => { const current = cards.find(item => item.id === card.id)!; current.width = Math.max(min.width, Math.min(1600, current.width! + (event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0))); current.height = Math.max(min.height, Math.min(1200, current.height! + (event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0))); });
          }}>⌟</Button>
        </article>;
      })}
      {loaded && !board.cards.length ? <Empty className="canvas-blank">
        <EmptyHeader><EmptyTitle>还没有组件</EmptyTitle><EmptyDescription>从已安装的插件中添加组件。</EmptyDescription></EmptyHeader>
        <EmptyContent><Button className="primary w-full" onClick={() => add()}>＋ 添加第一个组件</Button></EmptyContent>
      </Empty> : null}
    </main>
    {!viewOnly && menu ? <div ref={menuNode} className="canvas-menu fixed grid" role="menu" style={{ left: menu.x, top: menu.y }} onKeyDown={event => {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    }}>
      <Button role="menuitem" onClick={() => { setMenu(null); openCard(menu.card); }}>打开详情</Button>
      <Button role="menuitem" onClick={() => add(menu.card)}>编辑组件</Button>
      <Button role="menuitem" onClick={() => { setMenu(null); if (invoke) void api('settings').catch(error => setNotice(String(error))); }}>桌面组件设置</Button>
      <Button role="menuitem" onClick={() => commit(draft => { const board = draft.boards.find(board => board.id === draft.active)!; board.cards = board.cards.filter(card => card.id !== menu.card.id); })}>移除组件</Button>
    </div> : null}
    {editor ? <EditorDialog editor={editor} sources={sources} invoke={invoke} preview={preview} onClose={() => setEditor(null)} onSave={(plugin, title, config) => {
      const target = layoutRef.current.boards.find(board => board.id === editor.boardId);
      if (!target) throw Error('原布局已移除');
      if (!editor.card && target.cards.length >= 32) throw Error('每个布局最多 32 个组件');
      commit(draft => { const board = draft.boards.find(board => board.id === editor.boardId)!; const previous = board.cards.find(card => card.id === editor.card?.id); const next = { id: editor.card?.id || crypto.randomUUID(), plugin, title, config, view: 'widget', size: previous?.size || 'medium' as const }; if (previous) Object.assign(previous, next); else board.cards.push(next); });
      setEditor(null);
    }} /> : null}
    {naming ? <Dialog title={naming === 'new' ? '新建布局' : '重命名布局'} busy={false} onClose={() => setNaming(null)}><form className="grid gap-3" id="nameForm" onSubmit={event => {
      event.preventDefault(); const title = name.trim(); if (!title) return;
      if (naming === 'new' && layoutRef.current.boards.length >= 12) return;
      commit(draft => { if (naming === 'new') { const id = crypto.randomUUID(); draft.boards.push({ id, title, cards: [] }); draft.active = id; } else draft.boards.find(board => board.id === draft.active)!.title = title; }); setNaming(null);
    }}><Input id="boardName" aria-label="布局名称" autoFocus required maxLength={40} value={name} onChange={event => setName(event.target.value)} /><div className="flex gap-2"><Button onClick={() => setNaming(null)}>取消</Button><Button type="submit" className="primary">保存</Button></div></form></Dialog> : null}
    {deleting ? <Dialog title="删除此布局？" busy={false} onClose={() => setDeleting(false)}><p>其中的卡片布局会被移除，插件配置不受影响。</p><div className="flex gap-2"><Button onClick={() => setDeleting(false)}>取消</Button><Button id="confirmDelete" onClick={() => { if (layoutRef.current.boards.length > 1) commit(draft => { draft.boards = draft.boards.filter(board => board.id !== draft.active); draft.active = draft.boards[0].id; }); setDeleting(false); }}>删除布局</Button></div></Dialog> : null}
  </div>;
}
