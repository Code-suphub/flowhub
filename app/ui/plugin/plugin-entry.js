// The React settings owner supplies the iframe; this bridge owns only native RPC.
(() => {
  let installed = [], frame = null, currentModule = '', generation = 0, refreshVersion = 0;
  const listeners = new Set();
  const invoke = window.__TAURI__?.core?.invoke;
  function show(module) {
    if (!frame || module === currentModule) return;
    currentModule = module; generation++;
    if (module === 'extensions') { frame.removeAttribute('sandbox'); frame.src = 'plugin-market.html'; return; }
    const plugin = installed.find(p => p.enabled && `plugin:${p.manifest.id}` === module);
    if (!plugin) { frame.setAttribute('sandbox', 'allow-scripts'); frame.src = 'about:blank'; return; }
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = `flowhub-plugin://${plugin.manifest.id}/${plugin.manifest.ui.split('/').pop()}?embedded=1&v=${Date.now()}`;
  }
  async function refresh() {
    if (!invoke) return;
    const version = ++refreshVersion;
    const result = await invoke('plugin_api', { action: 'list', payload: {} });
    if (version !== refreshVersion) return;
    installed = Array.isArray(result) ? result : [];
    if (currentModule.startsWith('plugin:') && !installed.some(p => p.enabled && `plugin:${p.manifest.id}` === currentModule)) show('extensions');
    listeners.forEach(listener => listener());
  }
  window.FlowHubPluginIntegration = {
    refresh,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => installed,
    attach(element) { frame = element; currentModule = ''; generation++; return () => { if (frame === element) { frame = null; currentModule = ''; generation++; } }; },
    show,
    reload() { const previous = currentModule; currentModule = ''; show(previous); }
  };
  window.addEventListener('message', async event => {
    if (!frame || event.source !== frame.contentWindow || !currentModule.startsWith('plugin:') || !invoke) return;
    const request = event.data;
    if (request?.type !== 'flowhub:request' || typeof request.id !== 'string' || typeof request.method !== 'string') return;
    const version = generation, id = currentModule.slice(7), target = frame.contentWindow;
    try {
      const result = request.method === 'flowhub_status'
        ? await invoke('plugin_status_api', { id, action: 'open', payload: {} })
        : await invoke('plugin_rpc', { id, method: request.method, params: request.params || {} });
      if (version === generation && frame?.contentWindow === target) target.postMessage({ type: 'flowhub:response', id: request.id, result }, '*');
    } catch (error) { if (version === generation && frame?.contentWindow === target) target.postMessage({ type: 'flowhub:response', id: request.id, error: String(error) }, '*'); }
  });
  refresh().catch(console.error);
})();
