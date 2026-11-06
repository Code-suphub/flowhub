import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../shared/ui';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
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
  const [loading,setLoading]=useState(!readonly() && Boolean(invoke));
  const [readError,setReadError]=useState(''), [error, setError] = useState('');
  const pending = useRef(false), reading=useRef(false), alive = useRef(true), lifetime=useRef(0);
  const modeRevision = useRef({ viewOnly: 0, layoutLocked: 0 });
  const read=useCallback(async()=>{
    if(reading.current || pending.current || readonly() || !invoke)return;
    const version=lifetime.current, revision={...modeRevision.current};
    reading.current=true;setLoading(true);setReadError('');
    try {
      const result=await invoke<CanvasLayoutState>('plugin_canvas_api',{action:'get',payload:{}});
      if(!alive.current || version!==lifetime.current)return;
      if(!result?.layout || typeof result.layout!=='object' || Array.isArray(result.layout) || ['viewOnly','layoutLocked'].some(key=>{const value=result.layout[key as keyof CanvasLayoutState['layout']];return value!==undefined && typeof value!=='boolean';}))throw Error('组件状态格式无效，请重新读取。');
      if(revision.viewOnly===modeRevision.current.viewOnly)setViewOnly(result.layout.viewOnly===true);
      if(revision.layoutLocked===modeRevision.current.layoutLocked)setLayoutLocked(result.layout.layoutLocked===true);
      setLoaded(true);
    } catch(reason) {if(alive.current && version===lifetime.current)setReadError(reason instanceof Error?reason.message:String(reason));}
    finally {if(alive.current && version===lifetime.current){reading.current=false;setLoading(false);}}
  },[invoke]);

  useEffect(() => {
    alive.current = true;setBusy(false);setError('');setReadError('');
    if (readonly() || !invoke) { setLoaded(true);setLoading(false);return () => { alive.current = false;lifetime.current++; }; }
    setLoaded(false);
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
    void read();
    return () => { alive.current = false;lifetime.current++;reading.current=false;pending.current=false;window.removeEventListener('flowhub:canvas-view-only', sync); window.removeEventListener('flowhub:canvas-layout-locked', sync); };
  }, [invoke,read]);

  async function operate(action:'open'|'setViewOnly'|'setLayoutLocked',enabled?:boolean) {
    if (pending.current || reading.current || action!=='open' && !loaded || readonly() || !invoke) return;
    pending.current = true;
    const version=lifetime.current,mode=action==='setViewOnly'?'viewOnly':action==='setLayoutLocked'?'layoutLocked':null;
    const revision = mode?modeRevision.current[mode]:0;
    setBusy(true); setError('');
    try {
      await invoke('plugin_canvas_api', { action, payload: action==='open'?{}:{enabled} });
      if (alive.current && version===lifetime.current && mode && revision === modeRevision.current[mode]) window.dispatchEvent(new window.CustomEvent(mode === 'viewOnly' ? 'flowhub:canvas-view-only' : 'flowhub:canvas-layout-locked', { detail: enabled }));
    } catch (reason) { if (alive.current && version===lifetime.current) setError(reason instanceof Error?reason.message:String(reason)); }
    finally {if(alive.current && version===lifetime.current){pending.current=false;setBusy(false);}}
  }

  return <section className="settings-canvas max-w-2xl" aria-label="桌面组件设置">
    {loading?<p role="status" className="fh-muted">正在读取组件设置…</p>:null}
    {readError?<Alert variant="destructive" className="mb-4"><AlertTitle>组件设置未能读取</AlertTitle><AlertDescription>{readError}</AlertDescription><Button size="sm" aria-label="重新读取组件设置" disabled={loading || busy} onClick={()=>void read()}>重新读取</Button></Alert>:null}
    <Toggle label="锁定布局" checked={layoutLocked} disabled={!loaded || loading || busy || readonly() || !invoke} onChange={value => { void operate('setLayoutLocked', value); }} />
    <p className="fh-muted mb-3">禁止移动、缩放和编辑布局，仍可打开详情及操作插件。</p>
    <Toggle label="仅查看桌面组件" checked={viewOnly} disabled={!loaded || loading || busy || readonly() || !invoke} onChange={value => { void operate('setViewOnly', value); }} />
    <p className="fh-muted">隐藏工具栏并关闭拖动和左键操作。右键菜单可打开详情或退出，也可在此关闭。</p>
    {error ? <Alert variant="destructive" className="mt-3"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {busy?<p role="status" className="fh-muted mt-3">正在处理组件操作…</p>:null}
    <Button className="mt-5" disabled={readonly() || busy || loading || !invoke} onClick={()=>void operate('open')}>打开桌面组件</Button>
  </section>;
}
