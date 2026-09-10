(async()=>{
  const invoke=window.__TAURI__?.core?.invoke,q=new URLSearchParams(location.search);
  try{
    let data;if(invoke)data=await invoke('plugin_canvas_api',{action:'detailContext',payload:{}});
    else {const base=q.get('preview');if(!base)throw Error('请提供插件预览地址');const source=await fetch(new URL('widget-preview.json',base)).then(r=>r.json());data={plugin:source.id,url:new URL(source.widget.detail,base).href,context:{config:JSON.parse(q.get('config')||'{}'),title:q.get('title')||'',snapshot:source.snapshot,preview:true}};}
    FlowHubWidgetFrame.mount(document.querySelector('#detail'),{url:data.url,context:data.context,rpc:invoke?params=>invoke('plugin_widget_rpc',{id:data.plugin,params}):null});
  }catch(e){document.querySelector('#notice').textContent='无法打开插件详情：'+e;}
})();
