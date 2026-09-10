(() => {
  // The frame identity binds RPC to its installed plugin, never to a child-supplied ID.
  window.FlowHubWidgetFrame={mount(frame,{url,context,rpc}){
    let disposed=false,sequence=0;const pending=new Map();
    const token=crypto.randomUUID(),target=new URL(url,location.href);target.hash=new URLSearchParams({flowhubWidgetToken:token});
    const send=data=>frame.contentWindow?.postMessage({...data,token},'*');
    const receive=async event=>{
      if(disposed||!frame.isConnected||event.source!==frame.contentWindow)return;
      const d=event.data;if(!d||typeof d!=='object'||d.token!==token)return;
      if(d.type==='flowhub:widget-ready')send({type:'flowhub:widget-init',context});
      if(d.type==='flowhub:widget-config'){const p=pending.get(d.id);if(!p)return;clearTimeout(p.timer);pending.delete(d.id);if(d.error)p.reject(Error(d.error));else if(!d.config||Array.isArray(d.config)||typeof d.config!=='object'||JSON.stringify(d.config).length>65536)p.reject(Error('组件配置无效'));else p.resolve(d.config);}
      if(d.type==='flowhub:widget-rpc'&&typeof d.id==='string'&&d.id.length<100){
        try{if(!rpc)throw Error('此页面不支持插件调用');const result=await rpc(d.params||{});if(!disposed)send({type:'flowhub:widget-result',id:d.id,result});}catch(e){if(!disposed)send({type:'flowhub:widget-result',id:d.id,error:String(e)});}
      }
    };
    window.addEventListener('message',receive);frame.setAttribute('sandbox','allow-scripts');frame.src=target.href;
    return {save(){return new Promise((resolve,reject)=>{const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(Error('组件编辑器未响应'));},5000);pending.set(id,{resolve,reject,timer});send({type:'flowhub:widget-save',id});});},dispose(){disposed=true;window.removeEventListener('message',receive);for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('组件页面已关闭'));}pending.clear();}};
  }};
})();
