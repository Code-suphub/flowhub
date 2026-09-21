import { call, host, readonly, write } from './api';
import { primaryUpdate } from './Core';
import { entries } from './model';
import type { SettingsStore } from './store';
// Bind synchronously before configuration loading, so native eval calls can queue.
export function bindNativeSettings(store: SettingsStore, navigate: (id: string) => void, section: (id: string) => void) {
  let disposed = false, updating = false, queuedUpdate = false;
  const queuedUrls: string[] = [];
  const previous = { runMenuUpdate: host().runMenuUpdate, prepareAddWebUrl: host().prepareAddWebUrl, switchModule: host().switchModule };
  function prepareAddWebUrl(value: string) {
    if (disposed || readonly()) return;
    if (!store.snapshot().config || store.snapshot().busy) { queuedUrls.push(value); return; }
    void store.run(async () => {
      const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP / HTTPS 网页');
      if (store.snapshot().jsonText !== null) store.applyJson();
      let id = entries(store.snapshot().config!.plugins.web.settings.items).find(e => e.node.url === url.href)?.node.id;
      if (!id) { id = `node-${crypto.randomUUID()}`; store.edit(c => { c.plugins.web.settings.items.push({ id, title: url.hostname, url: url.href }); }); }
      store.patch({ webSelection: id });
      navigate('web');
    });
  }
  async function runMenuUpdate() {
    if (disposed || updating) return;
    if (!store.snapshot().config || store.snapshot().busy) { queuedUpdate = true; return; }
    updating = true; navigate('core'); section('updates');
    try { await store.run(async () => { const update = await call('getUpdateState'); if (disposed) return; store.patch({ update }); if (['available', 'downloaded'].includes(update.status)) await primaryUpdate(store); else if (!['checking', 'downloading', 'installing'].includes(update.status)) { const result = await write('checkForUpdates'); if (result.state) store.patch({ update: result.state }); } }); }
    finally { updating = false; }
  }
  const switchModule = (module: string) => { if (!disposed) navigate(module); };
  host().prepareAddWebUrl = prepareAddWebUrl; host().runMenuUpdate = runMenuUpdate; host().switchModule = switchModule;
  const unsubscribeStore = store.subscribe(() => {
    if (!store.snapshot().config || store.snapshot().busy) return;
    if (queuedUrls.length) { const urls = queuedUrls.splice(0); queueMicrotask(() => { if (!disposed) urls.forEach(prepareAddWebUrl); }); }
    if (queuedUpdate) { queuedUpdate = false; queueMicrotask(() => { if (!disposed) void runMenuUpdate(); }); }
  });
  const update = (value: Record<string, unknown>) => { if (!disposed) store.patch({ update: value }); };
  const unsubscribeUpdate = (host().weborg?.onUpdateState || host().weborg?.onUpdateStateChanged)?.(update);
  const unsubscribeConfig = host().weborg?.onConfig?.(() => {
    if (disposed || store.snapshot().busy) return;
    if (store.dirty) { store.notice('外部配置已更新，当前草稿已保留。请重置后读取最新配置。', true); return; }
    void store.run(() => store.load(false));
  });
  const params = new URLSearchParams(window.location.search);
  const requestedModule = params.get('module');
  if (requestedModule) switchModule(['core', 'web', 'app', 'clipboard', 'memo', 'tools', 'extensions'].includes(requestedModule) ? requestedModule : 'core');
  if (params.get('addUrl')) prepareAddWebUrl(params.get('addUrl')!);
  if (params.get('update') === '1') void runMenuUpdate();
  if (params.has('addUrl') || params.has('update')) window.history.replaceState({}, '', window.location.pathname);
  return () => {
    disposed = true; queuedUrls.length = 0; unsubscribeStore(); unsubscribeUpdate?.(); unsubscribeConfig?.();
    if (host().prepareAddWebUrl === prepareAddWebUrl) host().prepareAddWebUrl = previous.prepareAddWebUrl;
    if (host().runMenuUpdate === runMenuUpdate) host().runMenuUpdate = previous.runMenuUpdate;
    if (host().switchModule === switchModule) host().switchModule = previous.switchModule;
  };
}
