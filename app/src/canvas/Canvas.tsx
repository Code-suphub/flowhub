import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVerticalIcon } from 'lucide-react';
import { Button, Dialog, Input } from '../shared/ui';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Field, FieldGroup, FieldLabel, FieldTitle } from '../components/ui/field';
import { EmptyState, Select, Switch } from '../shared/controls';
import { nativeHost } from '../shared/native';
import { WidgetSurface } from './WidgetSurface';
import { useCanvasActivity, type CanvasLifecycle } from './useCanvasActivity';
import { CompactBar, CompactSettings } from './CompactBar';
import { compactDemo, compactStatus, initialPresentation, presentationValue, type Favorite, type Presentation } from './compact-model';
import { browserDetailUrl } from './detail-navigation';
import { host, initialLayout, isLayout, minimum, normalize, cardConfig, type Card, type Config, type FrameHandle, type Invoke, type Layout, type Point, type Source } from './model';

type Editor = { boardId: string; card?: Card };
type ReturnTarget = { boardId: string; cardId: string; invalid?: boolean; plugin?: string; requestId?: string };
type DetailFailure = ReturnTarget & { selection?: Config; message: string };
type Menu = { kind: 'context' | 'toolbar'; card?: Card; x: number; y: number; pointer: boolean };
type Gesture = { id: string; pointer: number; node: HTMLElement; resize: boolean; origin: Point; left: number; top: number; width: number; height: number; moved: boolean; wanted?: Point; target: string | null; grown: number };

function EditorDialog({ editor, sources, invoke, preview, onClose, onSave }: {
  editor: Editor; sources: Source[]; invoke?: Invoke; preview: string | null;
  onClose(): void; onSave(plugin: string, title: string, config: Config): void;
}) {
  const [plugin, setPlugin] = useState(editor.card?.plugin || ''), [title, setTitle] = useState(editor.card?.title || '');
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const handle = useRef<FrameHandle | null>(null), saving = useRef(false), alive = useRef(true);
  const frozenSource = useRef<{ plugin: string; source?: Source }>({ plugin, source: sources.find(source => source.id === plugin && source.widget) });
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (frozenSource.current.plugin !== plugin) frozenSource.current = { plugin, source: sources.find(source => source.id === plugin && source.widget) };
  const source = frozenSource.current.source, availableSource = sources.find(source => source.id === plugin && source.widget);
  const sourceChanged = source && (!availableSource || JSON.stringify(source.lastLoadedAt) !== JSON.stringify(availableSource.lastLoadedAt));
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
      {sourceChanged ? <p role="status">插件已变更，当前编辑草稿仍保留；如需新版编辑器，请先取消并重新打开。</p> : null}
      <FieldGroup className="canvas-editor-fields gap-3">
        <Field data-disabled={busy}><FieldTitle id="sourceLabel">插件</FieldTitle><Select id="source" label="插件" labelledBy="sourceLabel" popupClassName="canvas-editor-select-popup" value={plugin} disabled={busy} options={[{ value: '', label: '请选择插件', disabled: true }, ...sources.filter(source => source.widget).map(source => ({ value: source.id, label: source.title }))]}
          onChange={value => { handle.current = null; setReady(false); setError(''); setPlugin(value); }} /></Field>
        {source ? <Field data-disabled={busy}><FieldLabel htmlFor="cardTitle">卡片名称</FieldLabel><Input id="cardTitle" value={title} maxLength={60} disabled={busy} placeholder="默认使用插件名称" onChange={event => setTitle(event.target.value)} /></Field> : null}
      </FieldGroup>
      {source ? <>
        <WidgetSurface key={plugin} kind="editor" source={source} card={editor.card?.plugin === plugin ? editor.card : undefined} invoke={invoke} preview={preview}
          onEditor={(value, isReady) => { handle.current = value; setReady(isReady); }} />
        {!ready ? <p role="status">等待插件编辑器就绪…</p> : null}
      </> : null}
    </form>
    {source ? <div className="canvas-editor-actions"><Button type="submit" form="widgetForm" className="primary w-full" disabled={!ready || busy}>{busy ? '保存中…' : editor.card ? '保存修改' : '添加到画布'}</Button></div> : null}
  </Dialog>;
}

export function Canvas() {
  const invoke = nativeHost()?.core?.invoke, previewParam = new URLSearchParams(location.search).get('preview');
  const demo = !invoke && previewParam === 'demo';
  let preview: string | null = null, previewError = '';
  if (!invoke && previewParam !== null && !demo) {
    try {
      const url = new URL(previewParam);
      if (!['http:', 'https:'].includes(url.protocol)) throw Error();
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      url.search = ''; url.hash = ''; preview = url.href;
    } catch { previewError = '预览地址无效，请使用完整的 HTTP 或 HTTPS 插件预览地址，或返回画布预览。'; }
  }
  const [layout, setLayout] = useState(initialLayout), layoutRef = useRef(layout);
  const [presentation, setPresentation] = useState(initialPresentation), presentationRef = useRef(presentation);
  const [compactBusy, setCompactBusy] = useState(false), compactPending = useRef(false), [compactSettings, setCompactSettings] = useState(false), [compactError, setCompactError] = useState('');
  const [sources, setSources] = useState<Source[]>([]), sourcesRef = useRef(sources);
  const [notice, setNotice] = useState(''), [loaded, setLoaded] = useState(false), [inactive, setInactive] = useState(false);
  const [framesReady, setFramesReady] = useState(false), [refreshError, setRefreshError] = useState('');
  const refreshCanvas = useRef<() => void>(() => {});
  const [previewFailure, setPreviewFailure] = useState(false);
  const [viewOnlyBusy, setViewOnlyBusy] = useState(false), [layoutLockBusy, setLayoutLockBusy] = useState(false);
  const modeRevision = useRef({ viewOnly: 0, layoutLocked: 0 }), modePending = useRef(false);
  const [editor, setEditor] = useState<Editor | null>(null), [naming, setNaming] = useState<'new' | 'rename' | null>(null), [name, setName] = useState(''), [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [selected, setSelected] = useState<ReturnTarget | null>(null), [detailFailure, setDetailFailure] = useState<DetailFailure | null>(null), [openingDetail, setOpeningDetail] = useState(false);
  const detailSequence = useRef(0);
  const returnTarget = useRef<ReturnTarget | null>(null);
  const returnRevision = useRef(0);
  const restoredReturns = useRef(new Set<string>());
  const canvas = useRef<HTMLElement>(null), toolbar = useRef<HTMLElement>(null), menuNode = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null), suppressClick = useRef(0), saving = useRef(0), saveTail = useRef(Promise.resolve());
  const fitted = useRef(''), alive = useRef(true);
  const restoredGeometryFit = useRef(false);
  const activity = useCanvasActivity(invoke, () => { cancelGesture(); setMenu(null); setFramesReady(false); }, message => { setRefreshError(message); setNotice(message); });
  const board = layout.boards.find(board => board.id === layout.active)!;
  const viewOnly = layout.viewOnly === true;
  const layoutLocked = layout.layoutLocked === true, editingDisabled = demo || viewOnly || layoutLocked || layoutLockBusy || viewOnlyBusy || compactBusy;
  const menuCard = menu?.card;
  const width = Math.max(320, ...board.cards.map(card => (card.x || 0) + (card.width || 184)));
  const height = Math.max(120, ...board.cards.map(card => (card.y || 0) + (card.height || 184)));
  const current = useRef({ editor, naming, deleting, menu, compactSettings }); current.current = { editor, naming, deleting, menu, compactSettings };
  const modalOpen = () => !!(current.current.editor || current.current.naming || current.current.deleting || current.current.compactSettings);
  const moreButton = () => toolbar.current?.querySelector<HTMLButtonElement>('#canvasMore');
  function closeMenu(restore = false) {
    const active = current.current.menu;
    setMenu(null);
    if (!restore || !active) return;
    if (active.kind === 'toolbar') moreButton()?.focus();
    else if (active.card) [...(canvas.current?.querySelectorAll<HTMLElement>('[data-id]') || [])].find(node => node.dataset.id === active.card?.id)?.focus();
  }
  const api = <T = unknown,>(action: string, payload: unknown = {}) => invoke!<T>('plugin_canvas_api', { action, payload });
  function cancelGesture() {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    Object.assign(g.node.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
    g.node.classList.remove('moving');
    canvas.current?.querySelectorAll('.swap-target').forEach(node => node.classList.remove('swap-target'));
    if (g.node.hasPointerCapture(g.pointer)) g.node.releasePointerCapture(g.pointer);
    if (g.moved) suppressClick.current = Date.now() + 150;
  }
  function fitSurface() {
    if (!loaded || !invoke || !activity.isActive() || presentationRef.current.collapsed || compactPending.current || gesture.current || modalOpen() || !canvas.current || !toolbar.current) return;
    if (restoredGeometryFit.current) { restoredGeometryFit.current = false; return; }
    const width = Math.max(360, canvas.current.offsetWidth + 32, toolbar.current.scrollWidth + 32);
    const height = canvas.current.offsetTop + canvas.current.offsetHeight + 16, key = `${width}:${height}`;
    if (key === fitted.current) return;
    fitted.current = key; void api('fit', { width, height }).catch(() => { fitted.current = ''; });
  }
  function acceptPresentation(value: unknown) {
    if (!alive.current) return;
    const next = presentationValue(value);
    if (!next || next.revision < presentationRef.current.revision) return;
    if (next.collapsed !== presentationRef.current.collapsed) { cancelGesture(); setMenu(null); setEditor(null); setNaming(null); setDeleting(false); }
    presentationRef.current = next; setPresentation(next);
  }
  async function changeCompact(action: 'configureCompact' | 'setCompact' | 'snapCompact', payload: Record<string, unknown>): Promise<boolean> {
    if (!loaded || compactPending.current || modePending.current) return false;
    compactPending.current = true; setCompactBusy(true); setCompactError('');
    cancelGesture(); setMenu(null); setEditor(null); setNaming(null); setDeleting(false);
    try {
      await saveTail.current;
      if (invoke) { const result = await api<{ presentation: Presentation }>(action, payload); acceptPresentation(result.presentation); }
      else {
        const current = presentationRef.current, next = { ...current, revision: current.revision + 1 };
        if (action === 'configureCompact') { next.enabled = payload.enabled === true; next.favorites = payload.favorites as Favorite[]; if (!next.enabled) next.collapsed = false; }
        if (action === 'setCompact') next.collapsed = next.enabled && payload.collapsed === true;
        acceptPresentation(next);
      }
      if (action === 'setCompact') requestAnimationFrame(() => { if (!current.current.menu && !modalOpen() && document.activeElement === document.body) document.getElementById(presentationRef.current.collapsed ? 'expandCanvas' : 'collapseCanvas')?.focus(); });
      return true;
    } catch (error) { if (alive.current) { const message = `切换紧凑入口失败：${String(error)}`; setNotice(message); setCompactError(message); } return false; }
    finally { compactPending.current = false; if (alive.current) setCompactBusy(false); }
  }
  function commit(change: (draft: Layout) => void, moving?: string, wanted?: Point, target?: string | null, presentation = false) {
    if (!loaded || modePending.current || compactPending.current || demo || layoutRef.current.viewOnly || (layoutRef.current.layoutLocked && !presentation)) return;
    const draft = structuredClone(layoutRef.current); change(draft);
    const next = normalize(draft, sourcesRef.current, moving, wanted, target);
    layoutRef.current = next; setLayout(next); setMenu(null);
    // Each queued write owns an immutable snapshot; failures do not block later writes.
    const snapshot = structuredClone(next); saving.current++;
    saveTail.current = saveTail.current.catch(() => {}).then(async () => {
      try {
        if (invoke) await api('save', snapshot.layoutLocked && presentation ? { active: snapshot.active, pinned: snapshot.pinned } : snapshot);
        else localStorage.setItem('flowhub-canvas-preview', JSON.stringify({ ...snapshot, layoutLocked: layoutRef.current.layoutLocked }));
        if (alive.current && invoke) setNotice('');
      } catch (error) {
        if (alive.current) setNotice(`保存失败：${error}`);
        // A settings window can lock the layout while an old full save is queued.
        // Restore only board content while locked; presentation changes stay local.
        if (invoke && layoutRef.current.layoutLocked) {
          try {
            const result = await api<{ layout: Layout }>('get');
            if (alive.current && layoutRef.current.layoutLocked && isLayout(result.layout)) {
              const next = normalize({ ...layoutRef.current, boards: result.layout.boards }, sourcesRef.current);
              layoutRef.current = next; setLayout(next);
            }
          } catch { /* Preserve the original save error for retry. */ }
        }
      }
      finally { saving.current--; }
    });
  }
  const changeCards = (change: (cards: Card[]) => void) => commit(draft => change(draft.boards.find(board => board.id === draft.active)!.cards));
  const changePresentation = (change: (draft: Layout) => void) => commit(change, undefined, undefined, undefined, true);
  function add(card?: Card) {
    if (!loaded || modePending.current || compactPending.current || demo || layoutRef.current.viewOnly || layoutRef.current.layoutLocked) return;
    if (!sourcesRef.current.some(source => source.widget)) { setNotice('请先安装或升级提供组件页面的插件'); return; }
    const active = layoutRef.current.boards.find(board => board.id === layoutRef.current.active)!;
    if (!card && active.cards.length >= 32) { setNotice('每个布局最多 32 个组件'); return; }
    setMenu(null); setEditor({ boardId: active.id, card });
    if (invoke) void api('fit', { width: Math.max(innerWidth, 360), height: Math.max(innerHeight, 560) }).catch(() => {});
  }
  async function openCard(card: Card, selection?: Config, boardId = layoutRef.current.active) {
    const source = sourcesRef.current.find(source => source.id === card.plugin);
    if (!source?.widget?.detail) return;
    const sequence = ++detailSequence.current;
    const title = card.title || sourcesRef.current.find(source => source.id === card.plugin)?.title || '插件详情';
    const config = { ...cardConfig(card), ...(selection ? { selection } : {}) };
    setOpeningDetail(true); setDetailFailure(null); setSelected({ boardId, cardId: card.id });
    try {
      // Detail ownership is checked against the persisted layout, including a just-added card.
      await saveTail.current;
      if (!alive.current) return;
      if (invoke) await api('detail', { plugin: card.plugin, boardId, cardId: card.id, config, title });
      else location.href = browserDetailUrl(location.href, preview, boardId, card.id, config, title, card.plugin);
    } catch (error) {
      if (alive.current && sequence === detailSequence.current) setDetailFailure({ boardId, cardId: card.id, selection, message: `无法打开详情：${String(error)}` });
    } finally { if (alive.current && sequence === detailSequence.current) setOpeningDetail(false); }
  }
  function restoreReturn(target: ReturnTarget) {
    if (target.requestId) {
      if (restoredReturns.current.has(target.requestId)) return;
      restoredReturns.current.add(target.requestId);
    }
    const owner = layoutRef.current.boards.find(board => board.id === target.boardId);
    if (target.invalid || !owner?.cards.some(card => card.id === target.cardId && (!target.plugin || card.plugin === target.plugin))) { setSelected(null); setNotice('原组件已移除或更换，已返回当前画布。'); return; }
    cancelGesture(); setMenu(null); setEditor(null); setNaming(null); setDeleting(false); setDetailFailure(null);
    const next = normalize({ ...layoutRef.current, active: target.boardId }, sourcesRef.current);
    layoutRef.current = next; setLayout(next); setSelected(target);
    if (!invoke) {
      try {
        const stored: unknown = JSON.parse(localStorage.getItem('flowhub-canvas-preview') || 'null');
        if (isLayout(stored)) localStorage.setItem('flowhub-canvas-preview', JSON.stringify({ ...stored, active: target.boardId }));
      } catch { /* Returning remains possible when optional browser storage is unavailable. */ }
    }
  }
  async function changeViewOnly(enabled: boolean) {
    if (!invoke || modePending.current || !loaded) return;
    modePending.current = true;
    const revision = modeRevision.current.viewOnly;
    cancelGesture(); setMenu(null); setEditor(null); setNaming(null); setDeleting(false);
    setViewOnlyBusy(true);
    try {
      await api('setViewOnly', { enabled });
      if (alive.current && revision === modeRevision.current.viewOnly) window.dispatchEvent(new CustomEvent('flowhub:canvas-view-only', { detail: enabled }));
      setNotice('');
    } catch (error) { setNotice(`切换仅查看模式失败：${error}`); }
    finally { modePending.current = false; setViewOnlyBusy(false); }
  }
  async function changeLayoutLocked(enabled: boolean) {
    if (modePending.current || !loaded) return;
    modePending.current = true; setLayoutLockBusy(true);
    const revision = modeRevision.current.layoutLocked;
    cancelGesture(); setMenu(null); setEditor(null); setNaming(null); setDeleting(false);
    try {
      if (invoke) await api('setLayoutLocked', { enabled });
      else {
        await saveTail.current.catch(() => {});
        localStorage.setItem('flowhub-canvas-preview', JSON.stringify({ ...layoutRef.current, layoutLocked: enabled }));
      }
      if (alive.current) {
        if (revision === modeRevision.current.layoutLocked) window.dispatchEvent(new CustomEvent('flowhub:canvas-layout-locked', { detail: enabled }));
        if (invoke) setNotice('');
      }
    } catch (error) { if (alive.current) setNotice(`切换锁定布局失败：${error}`); }
    finally { modePending.current = false; if (alive.current) setLayoutLockBusy(false); }
  }
  const actions = useRef({ fitSurface, openCard, add }); actions.current = { fitSurface, openCard, add };
  useEffect(() => {
    alive.current = true; let stopped = false, request = 0, initialized = false, refreshRequired = true;
    let interval: ReturnType<typeof setInterval> | undefined;
    document.body.classList.toggle('preview', !invoke);
    async function load(initial = false) {
      initial = initial || !initialized;
      const resume = refreshRequired;
      if (stopped || !activity.isActive() || saving.current || gesture.current || (!initial && !resume && (modalOpen() || current.current.menu))) return;
      const sequence = ++request, lifecycleGeneration = activity.generation(), revision = { ...modeRevision.current }, returnVersion = returnRevision.current;
      try {
        if (previewError) throw Error(previewError);
        let nextSources = sourcesRef.current, nextLayout = layoutRef.current, nextReturnTarget: ReturnTarget | undefined, nextPresentation: unknown, nextGeometryRestored = false;
        if (invoke) {
          const data = await invoke<{ layout: Layout; sources: Source[]; returnTarget?: ReturnTarget; presentation?: Presentation; windowGeometryRestored?: boolean; lifecycle?: CanvasLifecycle }>('plugin_canvas_api', { action: 'get', payload: {} });
          if (stopped) return;
          activity.accept(data.lifecycle);
          if (initial) nextLayout = data.layout; nextSources = data.sources;
          nextReturnTarget = data.returnTarget; nextPresentation = data.presentation;
          nextGeometryRestored = data.windowGeometryRestored === true;
        } else if (demo) {
          if (initial) { const data = compactDemo(); nextLayout = data.layout; nextSources = data.sources; nextPresentation = data.presentation; }
        } else if (initial) {
          try { const stored: unknown = JSON.parse(localStorage.getItem('flowhub-canvas-preview') || 'null'); if (isLayout(stored)) nextLayout = stored; } catch { /* Preview storage is optional. */ }
          if (preview) {
            try {
              const response = await fetch(new URL('widget-preview.json', preview));
              if (!response.ok) throw Error();
              nextSources = [await response.json() as Source];
            } catch { throw Error('无法加载插件预览，请确认预览服务已启动且地址可访问，或返回画布预览。'); }
          }
        }
        if (stopped || !activity.isActive() || lifecycleGeneration !== activity.generation() || sequence !== request || saving.current || gesture.current || (!initial && !resume && (modalOpen() || current.current.menu))) return;
        if (nextPresentation) acceptPresentation(nextPresentation);
        if (initial) restoredGeometryFit.current = nextGeometryRestored && !presentationRef.current.collapsed;
        if (nextReturnTarget && returnVersion === returnRevision.current) returnTarget.current = nextReturnTarget;
        // A user mutation may have finished while the snapshot request was in flight.
        if (!initial) nextLayout = layoutRef.current;
        else nextLayout = { ...nextLayout,
          viewOnly: revision.viewOnly === modeRevision.current.viewOnly ? nextLayout.viewOnly : layoutRef.current.viewOnly,
          layoutLocked: revision.layoutLocked === modeRevision.current.layoutLocked ? nextLayout.layoutLocked : layoutRef.current.layoutLocked,
        };
        if (!isLayout(nextLayout)) throw Error('组件布局无效');
        sourcesRef.current = nextSources; setSources(nextSources);
        const normalized = normalize(nextLayout, nextSources); layoutRef.current = normalized; setLayout(normalized);
        if (initialized && returnTarget.current) { const target = returnTarget.current; returnTarget.current = null; restoreReturn(target); }
        if (!invoke) { setNotice(demo ? '只读演示 · 紧凑入口设置仅在本次预览生效' : preview ? '浏览器预览 · 只读模拟数据' : '浏览器预览'); setPreviewFailure(false); }
        else setNotice('');
        initialized = true; refreshRequired = false; setLoaded(true); setFramesReady(true); setRefreshError('');
      } catch (error) { if (!stopped && activity.isActive() && lifecycleGeneration === activity.generation() && sequence === request) { const message = error instanceof Error ? error.message : String(error); setNotice(message); if (invoke || resume) setRefreshError(message); if (!invoke && previewParam !== null) setPreviewFailure(true); } }
    }
    const start = () => { if (stopped || !activity.isActive()) return; void saveTail.current.catch(() => {}).then(() => { if (!stopped) void load(); }); if (interval === undefined) interval = window.setInterval(() => { void load(); }, 15000); };
    const unsubscribe = activity.subscribe(active => { request++; refreshRequired = true; clearInterval(interval); interval = undefined; if (active) start(); });
    // Returning to a visible document refreshes a still-present desktop canvas
    // immediately, without changing native activity or creating another timer.
    const visibility = () => { if (invoke && !document.hidden && activity.isActive()) void load(); };
    document.addEventListener('visibilitychange', visibility);
    refreshCanvas.current = () => { setRefreshError(''); if (activity.isActive()) start(); else void activity.probe(); };
    start();
    return () => { stopped = true; alive.current = false; request++; clearInterval(interval); unsubscribe(); document.removeEventListener('visibilitychange', visibility); document.body.classList.remove('preview'); };
  }, [invoke, preview, previewError, previewParam, demo]);
  useEffect(() => {
    const receive = (event: Event) => acceptPresentation((event as CustomEvent<unknown>).detail);
    const pin = (event: Event) => { const pinned = (event as CustomEvent<unknown>).detail; if (typeof pinned !== 'boolean') return; const next = { ...layoutRef.current, pinned }; layoutRef.current = next; setLayout(next); };
    const error = (event: Event) => { const message = (event as CustomEvent<unknown>).detail; if (typeof message === 'string') setNotice(message); };
    window.addEventListener('flowhub:canvas-presentation', receive);
    window.addEventListener('flowhub:canvas-pinned', pin);
    window.addEventListener('flowhub:canvas-error', error);
    return () => { window.removeEventListener('flowhub:canvas-presentation', receive); window.removeEventListener('flowhub:canvas-pinned', pin); window.removeEventListener('flowhub:canvas-error', error); };
  }, []);
  useEffect(() => {
    document.body.classList.toggle('canvas-compact-mode', presentation.collapsed);
    return () => document.body.classList.remove('canvas-compact-mode');
  }, [presentation.collapsed]);
  useEffect(() => { if (!loaded) return; fitted.current = ''; const frame = requestAnimationFrame(() => actions.current.fitSurface()); return () => cancelAnimationFrame(frame); }, [width, height, editor, naming, deleting, loaded, viewOnly, layoutLocked]);
  useEffect(() => {
    const receive = (value: unknown, fresh = false) => {
      if (!value || typeof value !== 'object') return;
      const target = value as ReturnTarget;
      if (typeof target.boardId !== 'string' || typeof target.cardId !== 'string') return;
      if (fresh) returnRevision.current++;
      returnTarget.current = target;
      if (loaded) { returnTarget.current = null; restoreReturn(target); }
    };
    const returned = (event: Event) => { delete host().__flowhubCanvasReturn; receive((event as CustomEvent<unknown>).detail, true); };
    window.addEventListener('flowhub:canvas-return', returned);
    const query = new URLSearchParams(location.search), boardId = query.get('boardId') || query.get('board'), cardId = query.get('cardId') || query.get('card');
    const globalTarget = host().__flowhubCanvasReturn;
    const pending = globalTarget || returnTarget.current || (boardId && cardId ? { boardId, cardId, invalid: query.get('returnInvalid') === '1', plugin: query.get('returnPlugin') || undefined, requestId: query.get('returnRequestId') || undefined } : null);
    delete host().__flowhubCanvasReturn;
    if (pending) receive(pending, Boolean(globalTarget));
    return () => window.removeEventListener('flowhub:canvas-return', returned);
  }, [loaded]);
  useLayoutEffect(() => {
    if (!loaded || !selected || selected.boardId !== layout.active) return;
    [...(canvas.current?.querySelectorAll<HTMLElement>('[data-id]') || [])].find(node => node.dataset.id === selected.cardId)?.focus();
  }, [loaded, selected, layout.active]);
  useEffect(() => {
    const change = (event: Event) => {
      const enabled = (event as CustomEvent<boolean>).detail;
      if (typeof enabled !== 'boolean') return;
      const field = event.type === 'flowhub:canvas-layout-locked' ? 'layoutLocked' : 'viewOnly';
      modeRevision.current[field]++; cancelGesture();
      const next = { ...layoutRef.current, [field]: enabled };
      layoutRef.current = next; setLayout(next); setMenu(null); setEditor(null); setNaming(null); setDeleting(false);
    };
    window.addEventListener('flowhub:canvas-view-only', change);
    window.addEventListener('flowhub:canvas-layout-locked', change);
    return () => { window.removeEventListener('flowhub:canvas-view-only', change); window.removeEventListener('flowhub:canvas-layout-locked', change); };
  }, []);

  // One native cursor poll owns surface exit and menu tracking, including iframe crossings.
  useEffect(() => {
    if (presentation.collapsed) return;
    let stopped = !activity.isActive(), timer: ReturnType<typeof setTimeout> | undefined, leaveTimer: ReturnType<typeof setTimeout> | undefined, revision = 0, pollEpoch = 0;
    const cancelLeave = () => { clearTimeout(leaveTimer); leaveTimer = undefined; };
    const close = () => { cancelLeave(); setMenu(null); };
    function trackMenu(x: number, y: number) {
      const active = current.current.menu; if (!active?.pointer) return;
      const card = [...(canvas.current?.querySelectorAll<HTMLElement>('[data-id]') || [])].find(node => node.dataset.id === active.card?.id);
      const contains = (node?: HTMLElement | null) => { if (!node?.isConnected) return false; const r = node.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; };
      if (contains(menuNode.current) || contains(card)) cancelLeave();
      else if (!leaveTimer) leaveTimer = setTimeout(() => { leaveTimer = undefined; if (current.current.menu === active) close(); }, 180);
    }
    function track(x: number, y: number, frontmost = true) {
      // macOS can deliver a right-click without activating the application.
      // An explicitly opened pointer menu owns the interaction until cursor
      // exit, outside input or blur dismisses it; app activation is not required.
      const interacting = current.current.menu?.pointer === true;
      const inside = (frontmost || interacting) && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
      setInactive(!inside);
      if (!inside) close();
      trackMenu(x, y);
    }
    async function poll() {
      const generation = revision, owner = pollEpoch;
      try { const p = await invoke!<Point & { frontmost?: boolean }>('plugin_canvas_api', { action: 'cursor', payload: {} }); if (!stopped && owner === pollEpoch && generation === revision) track(p.x, p.y, p.frontmost !== false); } catch { /* A closing window may reject cursor IPC. */ }
      if (!stopped && owner === pollEpoch) timer = setTimeout(poll, 150);
    }
    const move = (event: PointerEvent | MouseEvent) => { if (stopped) return; revision++; track(event.clientX, event.clientY); };
    const down = (event: PointerEvent) => { if (!menuNode.current?.contains(event.target as Node) && !(current.current.menu?.kind === 'toolbar' && moreButton()?.contains(event.target as Node))) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && current.current.menu) { event.preventDefault(); cancelLeave(); closeMenu(true); } };
    const leave = () => { close(); if (!invoke) { revision++; track(-1, -1); } };
    const hide = () => { stopped = true; revision++; pollEpoch++; clearTimeout(timer); close(); };
    const show = () => { if (stopped && activity.isActive()) { stopped = false; if (invoke) void poll(); } };
    const unsubscribe = activity.subscribe(active => { if (active) show(); else hide(); });
    const visibility = () => { if (document.hidden) close(); };
    const blur = (event: FocusEvent) => { if (!(event.relatedTarget instanceof Node) || !document.contains(event.relatedTarget)) close(); };
    const focus = (event: FocusEvent) => { const node = event.target as Element, owner = current.current.menu?.card?.id; if (!menuNode.current?.contains(node) && !(current.current.menu?.kind === 'toolbar' && moreButton()?.contains(node)) && (!owner || node.closest?.('[data-id]')?.getAttribute('data-id') !== owner)) close(); };
    const scroll = (event: Event) => { if (!menuNode.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointermove', move, true); document.addEventListener('mousemove', move, true);
    document.addEventListener('contextmenu', move, true);
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key);
    document.documentElement.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', visibility); document.addEventListener('focusin', focus); document.addEventListener('scroll', scroll, true);
    window.addEventListener('blur', blur);
    if (invoke && !stopped) void poll();
    return () => {
      stopped = true; clearTimeout(timer); cancelLeave();
      document.removeEventListener('pointermove', move, true); document.removeEventListener('mousemove', move, true);
      document.removeEventListener('contextmenu', move, true);
      document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key);
      document.documentElement.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('focusin', focus); document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('blur', blur); unsubscribe();
    };
  }, [invoke, presentation.collapsed]);
  useLayoutEffect(() => {
    const node = menuNode.current;
    if (!menu || !node) return;
    const position = () => {
      const { width, height } = node.getBoundingClientRect(), anchor = menu.kind === 'toolbar' ? moreButton()?.getBoundingClientRect() : null;
      node.style.left = `${Math.max(8, Math.min(anchor?.left ?? menu.x, innerWidth - width - 8))}px`;
      node.style.top = `${Math.max(8, Math.min(anchor ? anchor.bottom + 4 : menu.y, innerHeight - height - 8))}px`;
    };
    position();
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [menu]);

  function start(event: ReactPointerEvent<HTMLElement>, card: Card) {
    if (modePending.current || layoutRef.current.viewOnly || layoutRef.current.layoutLocked || event.button !== 0) return;
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
  const context = (card: Card | undefined, x: number, y: number, pointer = true) => setMenu({ kind: 'context', card, x, y, pointer });
  const openMore = () => {
    const rect = moreButton()?.getBoundingClientRect();
    if (rect && loaded && !viewOnly) setMenu({ kind: 'toolbar', x: rect.left, y: rect.bottom + 4, pointer: false });
  };
  return <div className="fh-canvas-app" data-view-only={viewOnly} data-layout-locked={layoutLocked} data-compact={presentation.collapsed} data-presentation-active={activity.active}>
    {presentation.collapsed ? <><CompactBar layout={layout} sources={sources} presentation={presentation} busy={compactBusy} native={Boolean(invoke)} demo={demo}
      refreshError={refreshError} onRetry={() => refreshCanvas.current()}
      onExpand={() => { void changeCompact('setCompact', { collapsed: false }); }}
      onDrag={() => { if (invoke) void api('drag').catch(error => setNotice(String(error))); }}
      onMore={() => { if (invoke) void api('compactMenu').catch(error => setNotice(`无法打开状态条菜单：${String(error)}`)); }} />
      {notice && invoke ? <p role="status" className="compact-notice">{notice}</p> : null}</> : <>
    <header ref={toolbar} className={`canvas-toolbar flex flex-wrap items-center gap-2 ${inactive ? 'surface-inactive' : ''}`} inert={inactive || viewOnly}>
      <Button id="dragSurface" className="brand" size="icon" aria-label="拖动桌面组件区域" disabled={!invoke} onMouseDown={event => { if (event.button === 0 && invoke) void api('drag').catch(error => setNotice(String(error))); }}><GripVerticalIcon aria-hidden="true" /></Button>
      <Select id="boards" label="切换组件布局" popupClassName="canvas-board-select-popup" value={layout.active} disabled={!loaded || layoutLockBusy || viewOnlyBusy} options={layout.boards.map(board => ({ value: board.id, label: board.title }))} onChange={value => changePresentation(draft => { draft.active = value; })} />
      <div className="flex items-center gap-1"><Switch label="置顶" checked={layout.pinned} disabled={!loaded || demo || compactBusy || layoutLockBusy || viewOnlyBusy} onChange={value => changePresentation(draft => { draft.pinned = value; })} /><span>置顶</span></div>
      <div className="flex items-center gap-1"><Switch label="锁定布局" checked={layoutLocked} disabled={!loaded || demo || compactBusy || layoutLockBusy || viewOnlyBusy} onChange={value => { void changeLayoutLocked(value); }} /><span>锁定布局</span></div>
      <div className="flex items-center gap-1"><Switch label="仅查看桌面组件" checked={viewOnly} disabled={!loaded || !invoke || viewOnlyBusy || layoutLockBusy} onChange={value => { void changeViewOnly(value); }} /><span>仅查看</span></div>
      <Button id="add" className="primary" disabled={!loaded || editingDisabled || board.cards.length >= 32} onClick={() => add()}>添加</Button>
      {presentation.enabled && !viewOnly ? <Button id="collapseCanvas" disabled={!loaded || compactBusy || layoutLockBusy || viewOnlyBusy} onClick={() => { void changeCompact('setCompact', { collapsed: true }); }}>收起</Button> : null}
      <Button id="canvasMore" aria-haspopup="menu" aria-expanded={menu?.kind === 'toolbar'} aria-controls={menu?.kind === 'toolbar' ? 'canvasMenu' : undefined} disabled={!loaded} onClick={() => { if (menu?.kind === 'toolbar') closeMenu(true); else openMore(); }} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMore(); }
      }}>更多</Button>
      <Button id="closeSurface" aria-label="关闭组件区域" disabled={!invoke} onClick={() => { if (invoke) void api('close').catch(error => setNotice(String(error))); }}>×</Button>
    </header>
    {viewOnly && presentation.enabled ? <Button id="collapseCanvas" className="canvas-view-only-compact" disabled={compactBusy || layoutLockBusy || viewOnlyBusy} onClick={() => { void changeCompact('setCompact', { collapsed: true }); }}>收起为状态条</Button> : null}
    <p id="notice" role="status">{notice}</p>
    {refreshError ? <div className="canvas-refresh-error" role="alert"><span>组件更新失败，已保存布局与编辑草稿已保留。</span><Button onClick={() => refreshCanvas.current()}>重试更新组件</Button></div> : null}
    {openingDetail ? <p className="canvas-detail-loading" role="status">正在打开详情…</p> : null}
    {detailFailure ? <div className="canvas-detail-failure" role="alert"><p>{detailFailure.message}</p><Button disabled={openingDetail} onClick={() => {
      const card = layoutRef.current.boards.find(board => board.id === detailFailure.boardId)?.cards.find(card => card.id === detailFailure.cardId);
      if (card) void openCard(card, detailFailure.selection, detailFailure.boardId); else setDetailFailure({ ...detailFailure, message: '原组件已移除，请返回画布选择其他组件。' });
    }}>重试打开详情</Button><Button onClick={() => { setDetailFailure(null); restoreReturn(detailFailure); }}>返回画布</Button></div> : null}
    {previewFailure ? <a className="canvas-preview-return" href="plugin-canvas.html">返回画布预览</a> : null}
    <main ref={canvas} id="canvas" aria-label="插件画布" className="relative" style={{ width, height }} onDragStart={event => event.preventDefault()} onContextMenu={event => {
      if (viewOnly && !(event.target as Element).closest('[data-id]')) { event.preventDefault(); context(undefined, event.clientX, event.clientY); }
    }}>
      {board.cards.map(card => {
        const source = sources.find(source => source.id === card.plugin), title = card.title || source?.title || card.plugin, interactive = source?.widget?.interactive === true, hasDetail = Boolean(source?.widget?.detail);
        return <article key={`${board.id}:${card.id}`} data-id={card.id} data-selected={selected?.boardId === board.id && selected.cardId === card.id} tabIndex={0} className={`canvas-card absolute overflow-hidden ${interactive ? 'interactive' : ''} ${hasDetail ? 'has-detail' : ''}`} aria-label={`${title}，${viewOnly ? '仅查看，右键可退出' : hasDetail ? layoutLocked ? '布局已锁定，点击打开详情' : interactive ? '顶部拖动或右键编辑，列表可操作' : '点击打开详情，右键编辑' : '右键编辑组件'}`}
          style={{ left: card.x, top: card.y, width: card.width, height: card.height }}
          onPointerDown={event => start(event, card)} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
          onClick={event => { if (viewOnly || Date.now() < suppressClick.current || (event.target as Element).closest('button')) return; openCard(card); }}
          onContextMenu={event => { event.preventDefault(); context(card, event.clientX, event.clientY); }}
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            if (!viewOnly && event.key === 'Enter') { event.preventDefault(); openCard(card); }
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); context(card, rect.left + 20, rect.top + 20, false); }
          }}>
          {demo ? <div className="canvas-demo-card"><strong>{compactStatus(card, source).label}</strong><span>{compactStatus(card, source).metric}</span><span>只读演示</span></div> : source?.widget ? activity.active && framesReady ? <WidgetSurface source={source} card={card} kind="card" invoke={invoke} preview={preview} inactive={viewOnly} onNavigate={(action, selection) => { if (layoutRef.current.viewOnly) return; const current = layoutRef.current.boards.find(board => board.id === layoutRef.current.active)?.cards.find(item => item.id === card.id); if (current) { if (action === 'detail') actions.current.openCard(current, selection); else if (action === 'editor') actions.current.add(current); } }} /> : <div className="canvas-suspended-card" role="status">{activity.active ? refreshError ? '等待重试更新组件' : '正在恢复最新状态…' : '窗口未显示，组件已暂停'}</div> : <EmptyState>插件未启用或尚未提供组件页面 · 布局已保留</EmptyState>}
          <div className="widget-hit absolute" aria-hidden="true">{interactive ? '⠿' : ''}</div>
          <Button className="resize-handle absolute" data-resize aria-label="调整组件大小" disabled={editingDisabled} onKeyDown={event => {
            if (modePending.current || layoutRef.current.viewOnly || layoutRef.current.layoutLocked) return;
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation(); const min = minimum(card, sources);
            changeCards(cards => { const current = cards.find(item => item.id === card.id)!; current.width = Math.max(min.width, Math.min(1600, current.width! + (event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0))); current.height = Math.max(min.height, Math.min(1200, current.height! + (event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0))); });
          }}>⌟</Button>
        </article>;
      })}
      {loaded && !board.cards.length ? <Empty className="canvas-blank">
        <EmptyHeader><EmptyTitle>还没有组件</EmptyTitle><EmptyDescription>从已安装的插件中添加组件。</EmptyDescription></EmptyHeader>
        <EmptyContent><Button className="primary w-full" disabled={editingDisabled} onClick={() => add()}>添加第一个组件</Button></EmptyContent>
      </Empty> : null}
    </main>
    {menu ? <div id="canvasMenu" ref={menuNode} className={`canvas-menu fixed grid ${menu.kind === 'toolbar' ? 'canvas-toolbar-menu' : ''}`} role="menu" aria-label={menu.kind === 'toolbar' ? '布局与桌面组件操作' : '组件操作'} style={{ left: menu.x, top: menu.y }} onKeyDown={event => {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    }}>
      {menu.kind === 'toolbar' ? <>
        <Button id="newBoard" variant="ghost" size="sm" role="menuitem" disabled={!loaded || editingDisabled || layout.boards.length >= 12} onClick={() => { closeMenu(true); setName(''); setNaming('new'); }}>新建布局</Button>
        <Button id="rename" variant="ghost" size="sm" role="menuitem" disabled={!loaded || editingDisabled} onClick={() => { closeMenu(true); setName(board.title); setNaming('rename'); }}>重命名布局</Button>
        <Button id="removeBoard" variant="ghost" size="sm" role="menuitem" disabled={!loaded || editingDisabled || layout.boards.length < 2} onClick={() => { closeMenu(true); setDeleting(true); }}>删除布局</Button>
        <Button variant="ghost" size="sm" role="menuitem" disabled={compactBusy} onClick={() => { closeMenu(true); setCompactError(''); setCompactSettings(true); }}>紧凑状态条</Button>
        <div className="canvas-menu-separator" role="separator" />
      </> : null}
      {menuCard ? <>
        {sources.find(source => source.id === menuCard.plugin)?.widget?.detail ? <Button role="menuitem" onClick={() => { setMenu(null); void openCard(menuCard); }}>打开详情</Button> : null}
        <Button role="menuitem" disabled={editingDisabled} onClick={() => add(menuCard)}>编辑组件</Button>
      </> : null}
      <Button id={menu.kind === 'toolbar' ? 'canvasSettings' : undefined} variant={menu.kind === 'toolbar' ? 'ghost' : undefined} size={menu.kind === 'toolbar' ? 'sm' : undefined} role="menuitem" disabled={menu.kind === 'toolbar' && !invoke} onClick={() => { closeMenu(); if (invoke) void api('settings').catch(error => setNotice(String(error))); }}>桌面组件设置</Button>
      {menuCard ? <Button role="menuitem" disabled={editingDisabled} onClick={() => commit(draft => { const board = draft.boards.find(board => board.id === draft.active)!; board.cards = board.cards.filter(card => card.id !== menuCard.id); })}>移除组件</Button> : null}
      {viewOnly ? <Button role="menuitem" disabled={!invoke || viewOnlyBusy} onClick={() => { setMenu(null); void changeViewOnly(false); }}>{viewOnlyBusy ? '正在退出…' : '退出仅查看状态'}</Button> : null}
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
    </>}
    {compactSettings ? <CompactSettings layout={layout} presentation={presentation} busy={compactBusy} notice={compactError} onClose={() => setCompactSettings(false)} onSave={(enabled, favorites) => { void changeCompact('configureCompact', { enabled, favorites }).then(saved => { if (saved) setCompactSettings(false); }); }} /> : null}
  </div>;
}
