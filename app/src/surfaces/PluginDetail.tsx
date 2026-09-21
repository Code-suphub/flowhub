import { useEffect, useRef, useState } from 'react';
import { invoke, nativeHost } from '../shared/native';
type Context = {plugin: string; url: string; context: Record<string, unknown>};
interface FrameBridge {mount: (frame: HTMLIFrameElement, options: {url: string; context: Record<string, unknown>; rpc: ((params: unknown) => Promise<unknown>) | null}) => {dispose: () => void}}
export function PluginDetail() {
  const frame = useRef<HTMLIFrameElement>(null), [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true, bridge: {dispose: () => void} | undefined;
    const abort = new AbortController();
    void (async () => {
      try {
        const available = Boolean(nativeHost()?.core?.invoke);
        let data: Context;
        if (available) data = await invoke<Context>('plugin_canvas_api', {action: 'detailContext', payload: {}});
        else {
          const query = new URLSearchParams(location.search), base = query.get('preview');
          if (!base) throw Error('请提供插件预览地址');
          const response = await fetch(new URL('widget-preview.json', base), {signal: abort.signal});
          if (!response.ok) throw Error('无法读取预览配置');
          const source = await response.json();
          data = {plugin: source.id, url: new URL(source.widget.detail, base).href, context: {config: JSON.parse(query.get('config') || '{}'), title: query.get('title') || '', snapshot: source.snapshot, preview: true}};
        }
        if (!active || !frame.current) return;
        const host = (window as Window & {FlowHubWidgetFrame?: FrameBridge}).FlowHubWidgetFrame;
        if (!host) throw Error('插件安全桥未加载');
        bridge = host.mount(frame.current, {url: data.url, context: data.context, rpc: available ? params => invoke('plugin_widget_rpc', {id: data.plugin, params}) : null});
      } catch (error) {if (active) setNotice('无法打开插件详情：' + String(error));}
    })();
    return () => {active = false;abort.abort();bridge?.dispose();};
  }, []);
  return <main className="fh-root fh-detail-page">{notice ? <p role="alert">{notice}</p> : null}<iframe ref={frame} title="插件详情" sandbox="allow-scripts"/></main>;
}
