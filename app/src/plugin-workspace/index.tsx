import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { PuzzleIcon, XIcon } from 'lucide-react';
import { Button } from '../shared/ui';
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
  const [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const panel = useRef<HTMLElement>(null), dock = useRef<HTMLDivElement>(null);
  const accept = (next: WorkspaceSnapshot) => setState(old => next.revision >= old.revision ? next : old);
  function run(action: string, module?: string) { void workspaceCall(action, module).then(accept).catch(e => setError(String(e))); }
  useEffect(() => {
    const update = (event: Event) => accept((event as CustomEvent<WorkspaceSnapshot>).detail);
    window.addEventListener('flowhub-workspace', update);
    let alive = true;
    if (!readonly()) {
      void workspaceCall('ready').then(next => { if (alive) accept(next); }).catch(e => { if (alive) setError(String(e)); });
      void integration?.refresh().then(() => { if (alive) setLoaded(true); }).catch(e => { if (alive) setError(String(e)); });
    }
    return () => { alive = false; window.removeEventListener('flowhub-workspace', update); };
  }, [integration]);
  useEffect(() => {
    if (view !== 'panel' || !loaded) return;
    void workspaceCall('refresh').catch(e => setError(String(e)));
    if (state.open && state.module.startsWith('plugin:') && !installed.some(p => p.enabled && `plugin:${p.manifest.id}` === state.module)) run('select', 'extensions');
  }, [installed, loaded, state.module, state.open, view]);
  useEffect(() => { if (state.open) panel.current?.querySelector<HTMLButtonElement>('[aria-label="收起插件面板"]')?.focus(); }, [state.open]);
  useEffect(() => {
    if (view !== 'dock' || !dock.current || readonly()) return;
    const nav = dock.current.querySelector('nav');
    if (!nav) return;
    const observer = new ResizeObserver(() => { void workspaceCall('resize', undefined, Math.ceil(nav.getBoundingClientRect().width)).catch(e => setError(String(e))); });
    observer.observe(nav); return () => observer.disconnect();
  }, [view]);
  const enabled = installed.filter(p => p.enabled);
  const title = state.module === 'overflow' ? '更多插件' : state.module === 'extensions' ? '插件市场' : installed.find(p => `plugin:${p.manifest.id}` === state.module)?.manifest.name || '插件';
  if (readonly()) return <div className="fh-root workspace-preview-note">独立悬浮窗口请在 FlowHub App 中使用。<a href="settings.html?module=menubar">返回设置预览</a></div>;
  if (view === 'dock') return <div ref={dock} className="workspace-dock-window"><PluginDock installed={installed} busy={false} open={state.open} active={state.module} floating onSelect={id => run('select', id)} onHide={() => run('hide')} />{error ? <p role="alert" className="workspace-dock-error" title={error}>插件栏暂不可用，可从设置重新打开</p> : null}</div>;
  return <section ref={panel} className="fh-root workspace-panel" role="dialog" aria-label={title} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); run('close'); } }}>
    <header><div><span className="workspace-panel-eyebrow">插件工作区</span><h1>{title}</h1></div><Button aria-label="收起插件面板" title="收起插件面板" onClick={() => run('close')}><XIcon aria-hidden="true" /></Button></header>
    {error ? <p role="alert">{error}</p> : null}
    <div className="workspace-panel-content">{state.open && state.module === 'overflow' ? <div className="workspace-plugin-grid">{enabled.slice(3).map(p => <Button key={p.manifest.id} onClick={() => run('select', `plugin:${p.manifest.id}`)}><PuzzleIcon aria-hidden="true" /><span>{p.manifest.name}</span></Button>)}{enabled.length <= 3 ? <p>其余插件已显示在胶囊栏中。</p> : null}</div> : state.open && loaded ? <PluginFrame module={state.module} /> : null}</div>
    <footer>本地插件工作区</footer>
  </section>;
}
export function mountPluginWorkspace(element: HTMLElement) {
  const view = new URLSearchParams(location.search).get('view') === 'panel' ? 'panel' : 'dock';
  document.documentElement.dataset.workspaceView = view;
  createRoot(element).render(<PluginWorkspace view={view} />);
}
