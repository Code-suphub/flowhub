import { useEffect, useState } from 'react';
import { Button } from '../shared/ui';
import { nativeHost } from '../shared/native';
import { Toggle } from './fields';
import { readonly } from './api';

type CanvasLayoutState = { layout: { viewOnly?: boolean } };

export function CanvasSettings() {
  const invoke = nativeHost()?.core?.invoke;
  const [viewOnly, setViewOnly] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (readonly() || !invoke) { setLoaded(true); return; }
    let active = true;
    let revision = 0;
    const sync = (event: Event) => {
      const enabled = (event as CustomEvent<boolean>).detail;
      if (typeof enabled === 'boolean') { revision++; setViewOnly(enabled); }
    };
    window.addEventListener('flowhub:canvas-view-only', sync);
    const requestRevision = revision;
    void invoke<CanvasLayoutState>('plugin_canvas_api', { action: 'get', payload: {} })
      .then(result => { if (active) { if (revision === requestRevision) setViewOnly(result.layout.viewOnly === true); setLoaded(true); } })
      .catch(reason => { if (active) { setError(String(reason)); setLoaded(true); } });
    return () => { active = false; window.removeEventListener('flowhub:canvas-view-only', sync); };
  }, [invoke]);

  async function change(enabled: boolean) {
    if (busy || readonly() || !invoke) return;
    setBusy(true); setError('');
    try {
      await invoke('plugin_canvas_api', { action: 'setViewOnly', payload: { enabled } });
      setViewOnly(enabled);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  return <section className="settings-canvas max-w-2xl" aria-label="桌面组件设置">
    <Toggle label="仅查看桌面组件" checked={viewOnly} disabled={!loaded || busy || readonly()} onChange={value => { void change(value); }} help="开启后组件不能点击、拖动或右键操作，鼠标悬浮时也不会显示工具栏。可在此关闭。" />
    {error ? <p role="alert" className="settings-error mt-3">{error}</p> : null}
    <Button className="mt-5" disabled={readonly() || busy} onClick={() => { if (invoke) void invoke('plugin_canvas_api', { action: 'open', payload: {} }).catch(reason => setError(String(reason))); }}>打开桌面组件</Button>
  </section>;
}
