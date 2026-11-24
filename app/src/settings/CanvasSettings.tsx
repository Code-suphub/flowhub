import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../shared/ui';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { nativeHost } from '../shared/native';
import { Toggle } from './fields';
import { readonly } from './api';

type CanvasLayoutState = { layout: { viewOnly?: boolean; layoutLocked?: boolean }; visible?: boolean };
const canvasEvents = {
  setVisible: 'flowhub:canvas-visibility',
  setViewOnly: 'flowhub:canvas-view-only',
  setLayoutLocked: 'flowhub:canvas-layout-locked',
} as const;
type CanvasAction = keyof typeof canvasEvents;

export function CanvasSettings() {
  const invoke = nativeHost()?.core?.invoke;
  const [visible, setVisible] = useState<boolean | null>(null);
  const [viewOnly, setViewOnly] = useState(false);
  const [layoutLocked, setLayoutLocked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading,setLoading]=useState(!readonly() && Boolean(invoke));
  const [readError,setReadError]=useState(''), [error, setError] = useState('');
  const pending = useRef(false), reading=useRef(false), alive = useRef(true), lifetime=useRef(0);
  const revision = useRef({ setVisible: 0, setViewOnly: 0, setLayoutLocked: 0 });
  const read=useCallback(async()=>{
    if(reading.current || pending.current || readonly() || !invoke)return;
    const version=lifetime.current, requested={...revision.current};
    reading.current=true;setLoading(true);setReadError('');
    try {
      const result=await invoke<CanvasLayoutState>('plugin_canvas_api',{action:'get',payload:{}});
      if(!alive.current || version!==lifetime.current)return;
      if(!result?.layout || typeof result.layout!=='object' || Array.isArray(result.layout) || ['viewOnly','layoutLocked'].some(key=>{const value=result.layout[key as keyof CanvasLayoutState['layout']];return value!==undefined && typeof value!=='boolean';}))throw Error('组件状态格式无效，请重新读取。');
      if (requested.setVisible === revision.current.setVisible) setVisible(typeof result.visible === 'boolean' ? result.visible : null);
      if (requested.setViewOnly === revision.current.setViewOnly) setViewOnly(result.layout.viewOnly === true);
      if (requested.setLayoutLocked === revision.current.setLayoutLocked) setLayoutLocked(result.layout.layoutLocked === true);
      setLoaded(true);
    } catch(reason) {if(alive.current && version===lifetime.current)setReadError(reason instanceof Error?reason.message:String(reason));}
    finally {if(alive.current && version===lifetime.current){reading.current=false;setLoading(false);}}
  },[invoke]);

  useEffect(() => {
    alive.current = true;setBusy(false);setError('');setReadError('');
    if (readonly() || !invoke) { setLoaded(true);setLoading(false);return () => { alive.current = false;lifetime.current++; }; }
    setLoaded(false);
    setVisible(null);
    const controls = { setVisible, setViewOnly, setLayoutLocked };
    const unsubscribe = (Object.keys(canvasEvents) as CanvasAction[]).map(action => {
      const sync = (event: Event) => {
        const enabled = (event as CustomEvent<unknown>).detail;
        if (typeof enabled !== 'boolean') return;
        revision.current[action]++;
        controls[action](enabled);
      };
      window.addEventListener(canvasEvents[action], sync);
      return () => window.removeEventListener(canvasEvents[action], sync);
    });
    void read();
    return () => { alive.current = false;lifetime.current++;reading.current=false;pending.current=false;unsubscribe.forEach(remove => remove()); };
  }, [invoke,read]);

  async function operate(action: CanvasAction, enabled: boolean) {
    if (pending.current || reading.current || !loaded || readonly() || !invoke) return;
    pending.current = true;
    const version = lifetime.current, requested = revision.current[action];
    setBusy(true); setError('');
    try {
      const result = await invoke<{ visible?: boolean }>('plugin_canvas_api', { action, payload: { enabled } });
      if (!alive.current || version !== lifetime.current || requested !== revision.current[action]) return;
      const value = action === 'setVisible' ? result?.visible : enabled;
      if (typeof value !== 'boolean') throw Error('无法确认桌面组件的显示状态。');
      window.dispatchEvent(new window.CustomEvent(canvasEvents[action], { detail: value }));
    } catch (reason) { if (alive.current && version===lifetime.current) setError(reason instanceof Error?reason.message:String(reason)); }
    finally {if(alive.current && version===lifetime.current){pending.current=false;setBusy(false);}}
  }

  const preview = readonly();
  const unavailable = preview || !invoke;
  const controlsDisabled = unavailable || loading || busy || !loaded;
  const visibilityUnavailable = !invoke || (loaded && visible === null);

  return <section className="settings-canvas max-w-2xl min-w-0 grid gap-3 max-sm:[&_[data-slot=switch]]:after:-inset-y-3.5" aria-label="桌面组件设置">
    <div className="rounded-xl border border-[var(--fh-border)] bg-[var(--fh-surface-raised)] px-3 sm:px-4">
      <div className="settings-section">
        <Toggle
          label="显示桌面组件"
          note={preview ? '请在 FlowHub App 中操作。' : visibilityUnavailable ? '暂时无法读取显示状态。' : '关闭后保留布局，下次启动时保持隐藏。'}
          checked={visible === true}
          disabled={controlsDisabled || visible === null}
          onChange={value => void operate('setVisible', value)}
        />
      </div>
    </div>
    <section className="rounded-xl border border-[var(--fh-border)] bg-[var(--fh-surface-raised)] px-3 pt-3 sm:px-4" aria-labelledby="canvas-layout-heading">
      <h2 id="canvas-layout-heading" className="m-0 text-[15px] leading-[22px] font-semibold">布局与操作</h2>
      <div className="settings-section">
        <Toggle
          label="锁定布局"
          note="禁止移动、缩放和编辑布局，仍可操作组件。"
          checked={layoutLocked}
          disabled={controlsDisabled}
          onChange={value => void operate('setLayoutLocked', value)}
        />
        <Toggle
          label="仅查看桌面组件"
          note="隐藏工具栏，停用拖动和左键操作。右键菜单可打开详情或退出此模式。"
          checked={viewOnly}
          disabled={controlsDisabled}
          onChange={value => void operate('setViewOnly', value)}
        />
      </div>
    </section>
    {loading && <p role="status" className="fh-copy-note m-0">正在读取组件设置…</p>}
    {readError && <Alert variant="destructive">
      <AlertTitle>组件设置未能读取</AlertTitle>
      <AlertDescription>{readError}</AlertDescription>
      <Button size="sm" className="justify-self-start max-sm:min-h-11" aria-label="重新读取组件设置" disabled={unavailable || loading || busy} onClick={() => void read()}>重新读取</Button>
    </Alert>}
    {error && <Alert variant="destructive">
      <AlertTitle>操作未完成</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>}
    {busy && <p role="status" className="fh-copy-note m-0">正在处理组件操作…</p>}
  </section>;
}
