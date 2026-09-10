(() => {
  let installed=[],currentModule='',generation=0;
  const frame=document.querySelector('#pluginFrame'), invoke=window.__TAURI__?.core?.invoke;
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const button=(module,title)=>`<button class="module-button" type="button" data-module="${escape(module)}" aria-label="${escape(title)}" title="${escape(title)}"><i class="module-nav-icon">${window.flowhubIcon('plugins')}</i><span class="module-nav-copy"><strong>${escape(title)}</strong></span></button>`;
  async function refresh() {
    if (!invoke) return;
    installed=await invoke('plugin_api',{action:'list',payload:{}});
    renderPluginModules();
    if (state.module.startsWith('plugin:') && !installed.some(p=>p.enabled && 'plugin:'+p.manifest.id===state.module)) switchModule('extensions');
  }
  window.FlowHubPluginIntegration={
    navigation:()=>button('extensions','插件市场')+installed.filter(p=>p.enabled).map(p=>button('plugin:'+p.manifest.id,p.manifest.name)).join(''),
    has:module=>installed.some(p=>p.enabled && 'plugin:'+p.manifest.id===module),
    refresh,
    show(module) {
      if (module===currentModule) return;currentModule=module;generation++;
      if(module==='extensions'){frame.removeAttribute('sandbox');frame.src='plugin-market.html';return;}
      const plugin=installed.find(p=>p.enabled && 'plugin:'+p.manifest.id===module);
      if(!plugin)return;
      frame.setAttribute('sandbox','allow-scripts');
      frame.src=`flowhub-plugin://${plugin.manifest.id}/${plugin.manifest.ui.split('/').pop()}?embedded=1&v=${Date.now()}`;
    },
    reload(){const previous=currentModule;currentModule='';this.show(previous);}
  };
  window.addEventListener('message',async event=>{
    if(event.source!==frame.contentWindow || !currentModule.startsWith('plugin:') || !invoke)return;
    const request=event.data;if(request?.type!=='flowhub:request'||typeof request.id!=='string'||typeof request.method!=='string')return;
    const version=generation,id=currentModule.slice(7);
    try {
      const result=request.method==='flowhub_status'
        ? await invoke('plugin_status_api',{id,action:'open',payload:{}})
        : await invoke('plugin_rpc',{id,method:request.method,params:request.params||{}});
      if(version===generation)frame.contentWindow.postMessage({type:'flowhub:response',id:request.id,result},'*');
    } catch(error){if(version===generation)frame.contentWindow.postMessage({type:'flowhub:response',id:request.id,error:String(error)},'*');}
  });
  refresh().catch(console.error);
})();
