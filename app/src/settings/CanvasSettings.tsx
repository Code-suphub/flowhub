import { useEffect, useRef, useState } from 'react';
import { Button } from '../shared/ui';
import { nativeHost } from '../shared/native';
import { Toggle } from './fields';
import { readonly } from './api';

type CanvasLayoutState = { layout: { viewOnly?: boolean; layoutLocked?: boolean } };

export function CanvasSettings() {
  const invoke = nativeHost()?.core?.invoke;
  const [viewOnly, setViewOnly] = useState(false);
  const [layoutLocked, setLayoutLocked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false), alive = useRef(true);
  const modeRevision = useRef({ viewOnly: 0, layoutLocked: 0 });

  useEffect(() => {
    alive.current = true;
    if (readonly() || !invoke) { setLoaded(true); return () => { alive.current = false; }; }
    let active = true;
    const revision = modeRevision.current;
    const sync = (event: Event) => {
      const enabled = (event as CustomEvent<boolean>).detail;
      if (typeof enabled === 'boolean') {
        if (event.type === 'flowhub:canvas-layout-locked') { revision.layoutLocked++; setLayoutLocked(enabled); }
        else { revision.viewOnly++; setViewOnly(enabled); }
      }
    };
    window.addEventListener('flowhub:canvas-view-only', sync);
    window.addEventListener('flowhub:canvas-layout-locked', sync);
    const requestRevision = { ...revision };
    void invoke<CanvasLayoutState>('plugin_canvas_api', { action: 'get', payload: {} })
      .then(result => { if (active) {
        if (revision.viewOnly === requestRevision.viewOnly) setViewOnly(result.layout.viewOnly === true);
        if (revision.layoutLocked === requestRevision.layoutLocked) setLayoutLocked(result.layout.layoutLocked === true);
        setLoaded(true);
      } })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; alive.current = false; window.removeEventListener('flowhub:canvas-view-only', sync); window.removeEventListener('flowhub:canvas-layout-locked', sync); };
  }, [invoke]);

  async function change(mode: 'viewOnly' | 'layoutLocked', enabled: boolean) {
    if (pending.current || !loaded || readonly() || !invoke) return;
    pending.current = true;
    const revision = modeRevision.current[mode];
    setBusy(true); setError('');
    try {
      await invoke('plugin_canvas_api', { action: mode === 'viewOnly' ? 'setViewOnly' : 'setLayoutLocked', payload: { enabled } });
      if (alive.current && revision === modeRevision.current[mode]) window.dispatchEvent(new window.CustomEvent(mode === 'viewOnly' ? 'flowhub:canvas-view-only' : 'flowhub:canvas-layout-locked', { detail: enabled }));
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }

  return <section className="settings-canvas max-w-2xl" aria-label="桌面组件设置">
    <Toggle label="锁定布局" checked={layoutLocked} disabled={!loaded || busy || readonly() || !invoke} onChange={value => { void change('layoutLocked', value); }} />
    <p className="fh-muted mb-3">禁止移动、缩放和编辑布局，仍可打开详情及操作插件。</p>
    <Toggle label="仅查看桌面组件" checked={viewOnly} disabled={!loaded || busy || readonly() || !invoke} onChange={value => { void change('viewOnly', value); }} />
    <p className="fh-muted">隐藏工具栏并关闭拖动和左键操作。右键菜单可打开详情或退出，也可在此关闭。</p>
    {error ? <p role="alert" className="settings-error mt-3">{error}</p> : null}
    <Button className="mt-5" disabled={readonly() || busy} onClick={() => { if (invoke) void invoke('plugin_canvas_api', { action: 'open', payload: {} }).catch(reason => setError(String(reason))); }}>打开桌面组件</Button>
  </section>;
}
