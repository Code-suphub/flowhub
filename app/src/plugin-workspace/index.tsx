import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { LoaderCircleIcon, PuzzleIcon, RefreshCwIcon, XIcon } from 'lucide-react';
import { Button } from '../shared/ui';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { host, readonly, type InstalledPlugin } from '../settings/api';
import { PluginDock, PluginFrame } from './controls';
import { workspaceCall, type WorkspaceSnapshot } from './native';
import '../settings/glass.css';
import './workspace.css';

const empty: InstalledPlugin[] = [];
export function PluginWorkspace({ view }: { view: 'dock' | 'panel' }) {
  const integration = host().FlowHubPluginIntegration;
  const installed = useSyncExternalStore(integration?.subscribe || (() => () => {}), integration?.getSnapshot || (() => empty), () => empty);
  const [state, setState] = useState<WorkspaceSnapshot>({ module: 'extensions', open: false, revision: -1 });
  const [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [loading,setLoading] = useState(!readonly()), [attempt,setAttempt] = useState(0);
  const panel = useRef<HTMLElement>(null), dock = useRef<HTMLDivElement>(null);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const accept = (next: WorkspaceSnapshot) => setState(old => next.revision >= old.revision ? next : old);
  function run(action: string, module?: string) { setError('');void workspaceCall(action, module).then(next=>{if(mounted.current)accept(next);}).catch(e => {if(mounted.current)setError(String(e));}); }
  useEffect(() => {
    const update = (event: Event) => accept((event as CustomEvent<WorkspaceSnapshot>).detail);
    window.addEventListener('flowhub-workspace', update);
    let alive = true;
    if (!readonly()) {
      setLoading(true);setError('');
      const ready=workspaceCall('ready').then(next=>{if(alive)accept(next);});
      const catalog=integration?Promise.resolve().then(()=>integration.refresh()).then(()=>{if(alive)setLoaded(true);}):Promise.reject(new Error('插件连接尚未就绪，请重新连接。'));
      void Promise.allSettled([ready,catalog]).then(results=>{
        if(!alive)return;setLoading(false);
        const failures=results.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);
        if(failures.length)setError(failures.join('；'));
      });
    }
    return () => { alive = false; window.removeEventListener('flowhub-workspace', update); };
  }, [integration,attempt]);
  useEffect(() => {
    if (view !== 'panel' || !loaded) return;
    let active=true;
    void workspaceCall('refresh').catch(e => {if(active && mounted.current)setError(String(e));});
    if (state.open && state.module.startsWith('plugin:') && !installed.some(p => p.enabled && `plugin:${p.manifest.id}` === state.module)) run('select', 'extensions');
    return()=>{active=false;};
  }, [installed, loaded, state.module, state.open, view]);
  useEffect(() => { if (state.open && (document.activeElement===document.body || document.activeElement===panel.current)) panel.current?.querySelector<HTMLButtonElement>('[aria-label="收起插件面板"]')?.focus({preventScroll:true}); }, [state.open]);
  useEffect(() => {
    if (view !== 'dock' || !dock.current || readonly()) return;
    const nav = dock.current.querySelector('nav');
    if (!nav) return;
    const observer = new ResizeObserver(() => { void workspaceCall('resize', undefined, Math.ceil(nav.getBoundingClientRect().width)).catch(e => {if(mounted.current)setError(String(e));}); });
    observer.observe(nav); return () => observer.disconnect();
  }, [view]);
  const enabled = installed.filter(p => p.enabled);
  const title = state.module === 'overflow' ? '更多插件' : state.module === 'extensions' ? '插件市场' : installed.find(p => `plugin:${p.manifest.id}` === state.module)?.manifest.name || '插件';
  if (readonly()) return <div className="fh-root workspace-preview-note">独立悬浮窗口请在 FlowHub App 中使用。<a href="settings.html?module=menubar">返回设置预览</a></div>;
  if (view === 'dock') return <div ref={dock} className="workspace-dock-window"><PluginDock installed={installed} busy={!loaded} open={state.open} active={state.module} floating onSelect={id => run('select', id)} onHide={() => run('hide')} />{error ? <div role="alert" className="fh-root workspace-dock-error"><span title={error}>插件栏连接失败</span><Button size="icon-sm" aria-label="重新连接插件栏" disabled={loading} onClick={()=>setAttempt(value=>value+1)}><RefreshCwIcon /></Button><Button size="icon-sm" aria-label="隐藏插件栏" onClick={()=>run('hide')}><XIcon /></Button></div> : null}</div>;
  return <section ref={panel} className="fh-root workspace-panel" role="dialog" aria-label={title} onKeyDown={event => {
    if(event.key!=='Escape' || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode===229 || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey)return;
    if((event.target as HTMLElement).closest('[role=dialog],[role=menu],[role=listbox]')!==event.currentTarget)return;
    event.preventDefault();run('close');
  }}>
    <header><div><span className="workspace-panel-eyebrow">插件工作区</span><h1 title={title}>{title}</h1></div><Button aria-label="收起插件面板" title="收起插件面板" onClick={() => run('close')}><XIcon aria-hidden="true" /></Button></header>
    {error ? <Alert variant="destructive" className="workspace-connection-error"><AlertDescription>{error}</AlertDescription><Button size="sm" disabled={loading} onClick={()=>setAttempt(value=>value+1)}>重新连接</Button></Alert> : null}
    <div className="workspace-panel-content">{state.open && loaded && state.module === 'overflow' ? <div className="workspace-plugin-grid">{enabled.slice(3).map(p => <Button key={p.manifest.id} title={p.manifest.name} onClick={() => run('select', `plugin:${p.manifest.id}`)}><PuzzleIcon aria-hidden="true" /><span>{p.manifest.name}</span></Button>)}{enabled.length<=3?<Empty><EmptyHeader><EmptyMedia variant="icon"><PuzzleIcon /></EmptyMedia><EmptyTitle>没有更多插件</EmptyTitle><EmptyDescription>已启用的插件都在插件栏中，也可以浏览插件市场。</EmptyDescription></EmptyHeader><Button onClick={()=>run('select','extensions')}>浏览插件市场</Button></Empty>:null}</div> : state.open && loaded ? <PluginFrame module={state.module} /> : <Empty className="workspace-pending" role="status"><EmptyHeader><EmptyMedia variant="icon">{loading?<LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />:<PuzzleIcon />}</EmptyMedia><EmptyTitle>{loading?'正在准备插件工作区…':!loaded?'尚未连接插件工作区':'从插件栏选择一个插件'}</EmptyTitle><EmptyDescription>{loading?'正在读取本机插件与窗口状态。':!loaded?'通过上方“重新连接”重试。':'可以打开已有插件或浏览插件市场。'}</EmptyDescription></EmptyHeader>{loaded&&!loading?<Button onClick={()=>run('select','extensions')}>浏览插件市场</Button>:null}</Empty>}</div>
    <footer>本地插件工作区</footer>
  </section>;
}
export function mountPluginWorkspace(element: HTMLElement) {
  const view = new URLSearchParams(location.search).get('view') === 'panel' ? 'panel' : 'dock';
  document.documentElement.dataset.workspaceView = view;
  createRoot(element).render(<PluginWorkspace view={view} />);
}
