import { useEffect, useRef } from 'react';
import { cardConfig, host, surfaceUrl, type Card, type Config, type FrameHandle, type Invoke, type Source } from './model';
import type { useCanvasActivity } from './useCanvasActivity';

export function WidgetSurface({ source, card, kind, invoke, preview, inactive = false, activity, onNavigate, onEditor, onConfigure }: {
  source: Source; card?: Card; kind: 'card' | 'editor'; invoke?: Invoke; preview: string | null;
  inactive?: boolean;
  activity?: Pick<ReturnType<typeof useCanvasActivity>, 'isActive' | 'subscribe'>;
  onNavigate?: (action: string, selection?: Config) => void;
  onEditor?: (handle: FrameHandle | null, ready: boolean) => void;
  onConfigure?: (patch: Config) => Promise<void>;
}) {
  const frame = useRef<HTMLIFrameElement>(null), bridge = useRef<FrameHandle | null>(null);
  const canSaveConfig = kind === 'card' && !!invoke && !!onConfigure && !inactive;
  const latest = useRef({ source, card, onNavigate, onEditor, onConfigure, canSaveConfig });
  latest.current = { source, card, onNavigate, onEditor, onConfigure, canSaveConfig };
  const path = source.widget![kind], revision = JSON.stringify(source.lastLoadedAt);
  useEffect(() => {
    const node = frame.current!;
    const current = latest.current;
    const handle = host().FlowHubWidgetFrame.mount(node, {
      url: surfaceUrl(current.source, kind, !!invoke, preview),
      persistent: kind === 'card', active: activity?.isActive() ?? true,
      context: { config: cardConfig(current.card), title: current.card?.title || '', snapshot: current.source.snapshot, preview: !invoke, canSaveConfig: current.canSaveConfig },
      rpc: invoke ? async params => {
        if (params.action !== 'configureCard') return invoke('plugin_widget_rpc', { id: source.id, params });
        const target = latest.current;
        if (!target.canSaveConfig || !target.onConfigure) throw Error('当前无法保存卡片设置');
        const patch = params.patch;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || JSON.stringify(patch).length > 4096) throw Error('卡片设置无效');
        await target.onConfigure(patch as Config);
        return { saved: true };
      } : null,
      navigate: kind === 'card' ? (action, selection) => latest.current.onNavigate?.(action, selection) : null,
      resize: kind === 'editor' ? height => { node.style.height = `${height}px`; } : undefined,
    });
    bridge.current = handle;
    const unsubscribe = activity?.subscribe(active => handle.setActive(active));
    // Observe readiness only; all business messages and RPC remain in the original bridge.
    const token = new URLSearchParams(new URL(node.src).hash.slice(1)).get('flowhubWidgetToken');
    const ready = (event: MessageEvent) => {
      if (node.isConnected && event.source === node.contentWindow && event.data?.token === token && token && event.data.type === 'flowhub:widget-ready') latest.current.onEditor?.(handle, true);
    };
    if (kind === 'editor') { window.addEventListener('message', ready); latest.current.onEditor?.(handle, false); }
    return () => {
      window.removeEventListener('message', ready);
      unsubscribe?.();
      bridge.current = null; handle.dispose();
      if (kind === 'editor') latest.current.onEditor?.(null, false);
    };
  }, [source.id, path, revision, kind, invoke, preview, activity?.isActive, activity?.subscribe]);
  // An editor owns its in-progress draft. A resume cache refresh must not send
  // it another init that could replace form state; source/version changes remount.
  useEffect(() => { if (kind === 'card') bridge.current?.updateContext({ config: cardConfig(card), title: card?.title || '', snapshot: source.snapshot, preview: !invoke, canSaveConfig }); }, [kind, card, source.snapshot, invoke, canSaveConfig]);
  return <iframe ref={frame} id={kind === 'editor' ? 'widgetEditor' : undefined} className={kind === 'card' ? 'widget-content' : 'canvas-editor'}
    title={kind === 'editor' ? '插件组件配置' : card?.title || source.title} sandbox="allow-scripts" tabIndex={!inactive && (kind === 'editor' || source.widget?.interactive) ? 0 : -1} />;
}
