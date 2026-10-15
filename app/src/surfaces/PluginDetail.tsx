import { useEffect, useRef, useState } from 'react';
import { Button } from '../shared/ui';
import { invoke, nativeHost } from '../shared/native';
import { canvasReturnUrl, previewDetailUrl, previewDirectory } from '../canvas/detail-navigation';

type Context = { plugin: string; url: string; context: Record<string, unknown>; revision?: number };
type FrameHandle = { dispose(): void; updateContext(context: Record<string, unknown>): void };
interface FrameBridge { mount(frame: HTMLIFrameElement, options: { url: string; context: Record<string, unknown>; rpc: ((params: unknown) => Promise<unknown>) | null }): FrameHandle }

export function PluginDetail() {
  const frame = useRef<HTMLIFrameElement>(null), alive = useRef(true), actionPending = useRef(false);
  const [notice, setNotice] = useState(''), [title, setTitle] = useState('插件详情'), [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false);
  const [failureAction, setFailureAction] = useState<'load' | 'return' | 'close'>('load'), noticeKind = useRef<'load' | 'return' | 'close'>('load');
  const available = Boolean(nativeHost()?.core?.invoke);
  const back = canvasReturnUrl(new URLSearchParams(location.search).get('returnTo'), location.href);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true, bridge: FrameHandle | undefined, mountedKey = '', request = 0, acceptedRevision = -1, ready = false, loadFailed = false;
    let timer: number | undefined;
    const abort = new AbortController();
    setNotice(''); setLoading(true); setFailureAction('load'); noticeKind.current = 'load';
    const onReady = (event: MessageEvent) => {
      const node = frame.current;
      if (!active || !node || event.source !== node.contentWindow || event.data?.type !== 'flowhub:widget-ready') return;
      const token = new URL(node.src || location.href).hash.slice(1);
      if (!token || event.data.token !== new URLSearchParams(token).get('flowhubWidgetToken')) return;
      ready = true; clearTimeout(timer); setLoading(false);
      if (!loadFailed && noticeKind.current === 'load') setNotice('');
    };
    window.addEventListener('message', onReady);
    async function load() {
      const sequence = ++request;
      try {
        let data: Context;
        if (available) data = await invoke<Context>('plugin_canvas_api', { action: 'detailContext', payload: {} });
        else {
          const query = new URLSearchParams(location.search), base = previewDirectory(query.get('preview'));
          let source;
          try {
            const response = await fetch(new URL('widget-preview.json', base), { signal: abort.signal });
            if (!response.ok) throw Error();
            source = await response.json();
          } catch { throw Error('无法读取插件预览，请确认预览服务已启动且地址可访问。'); }
          let config: unknown;
          try { config = JSON.parse(query.get('config') || '{}'); } catch { throw Error('详情配置无效，请返回画布重新打开。'); }
          if (!config || typeof config !== 'object' || Array.isArray(config) || JSON.stringify(config).length > 65536) throw Error('详情配置无效，请返回画布重新打开。');
          data = { plugin: source.id, url: previewDetailUrl(source.widget?.detail, base), context: { config, title: (query.get('title') || '').slice(0, 120), snapshot: source.snapshot, preview: true } };
        }
        if (!active || sequence !== request || !frame.current) return;
        if (!data || typeof data.plugin !== 'string' || !data.plugin || typeof data.url !== 'string' || !data.context || typeof data.context !== 'object') throw Error('插件详情上下文无效。');
        const revision = data.revision ?? 0;
        if (!Number.isFinite(revision) || revision < acceptedRevision) return;
        acceptedRevision = revision;
        const host = (window as Window & { FlowHubWidgetFrame?: FrameBridge }).FlowHubWidgetFrame;
        if (!host) throw Error('插件安全桥未加载，请重试。');
        const key = `${data.plugin}\n${data.url}`;
        if (bridge && mountedKey === key) bridge.updateContext(data.context);
        else {
          bridge?.dispose(); ready = false; clearTimeout(timer); setLoading(true);
          bridge = host.mount(frame.current, { url: data.url, context: data.context, rpc: available ? params => invoke('plugin_widget_rpc', { id: data.plugin, params }) : null });
          mountedKey = key;
          timer = window.setTimeout(() => {
            if (active && !ready) { noticeKind.current = 'load'; setFailureAction('load'); setLoading(false); setNotice('插件详情未就绪，请重试或返回画布。'); }
          }, 10000);
        }
        setTitle(typeof data.context.title === 'string' && data.context.title ? data.context.title : '插件详情');
        loadFailed = false;
        if (ready) setLoading(false);
        if (noticeKind.current === 'load') setNotice('');
      } catch (error) {
        if (active && sequence === request) { loadFailed = true; noticeKind.current = 'load'; setFailureAction('load'); setLoading(false); setNotice(`无法打开插件详情：${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    const update = () => { void load(); };
    if (available) window.addEventListener('flowhub:detail-context-changed', update);
    void load();
    return () => {
      active = false; abort.abort(); clearTimeout(timer); bridge?.dispose();
      window.removeEventListener('message', onReady); window.removeEventListener('flowhub:detail-context-changed', update);
    };
  }, [available, attempt]);
  async function leave(close = false) {
    if (actionPending.current) return;
    if (!available) { location.href = back; return; }
    actionPending.current = true; setBusy(true);
    try { await invoke('plugin_canvas_api', { action: close ? 'detailClose' : 'detailReturn', payload: {} }); }
    catch (error) { if (alive.current) { noticeKind.current = close ? 'close' : 'return'; setFailureAction(noticeKind.current); setNotice(`无法${close ? '关闭详情' : '返回画布'}：${error instanceof Error ? error.message : String(error)}`); } }
    finally { actionPending.current = false; if (alive.current) setBusy(false); }
  }
  return <main className="fh-root fh-detail-page">
    <header className="fh-detail-toolbar"><Button disabled={busy} onClick={() => void leave()}>返回画布</Button><h1>{title}</h1>{available ? <Button disabled={busy} onClick={() => void leave(true)}>关闭详情</Button> : <span className="fh-detail-preview">浏览器预览 · 只读</span>}</header>
    {loading ? <p className="fh-detail-loading" role="status">正在加载详情…</p> : null}
    {notice ? <div className="fh-detail-error" role="alert"><p>{notice}</p><Button disabled={busy} onClick={() => { if (failureAction === 'load') setAttempt(value => value + 1); else void leave(failureAction === 'close'); }}>{failureAction === 'load' ? '重试加载' : failureAction === 'close' ? '重试关闭' : '重试返回'}</Button></div> : null}
    <iframe ref={frame} title={title} sandbox="allow-scripts" hidden={Boolean(notice) && failureAction === 'load'}/>
  </main>;
}
