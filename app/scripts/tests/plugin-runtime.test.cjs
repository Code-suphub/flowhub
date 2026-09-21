const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const h=require('./settings-harness.test.cjs');
const source=h.fs.readFileSync(h.path.join(__dirname,'../../ui/plugin/plugin-entry.js'),'utf8');
test('React ref attach enables sandboxed plugins; RPC identity is frame-bound and stale replies are dropped',async()=>{
 const listeners={},calls=[],responses=[];let gate;
 const frame={src:'',contentWindow:{postMessage:value=>responses.push(value)},setAttribute(k,v){this[k]=v;},removeAttribute(k){delete this[k];}};
 const window={addEventListener(k,fn){listeners[k]=fn;},__TAURI__:{core:{invoke:async(method,args)=>{
  if(method==='plugin_api')return [{enabled:true,manifest:{id:'example',name:'Example',ui:'ui/index.html'}}];
  calls.push({method,args});if(args.method==='slow')await new Promise(r=>{gate=r;});return {ok:true};
 }}}};
 vm.runInNewContext(source,{window,console});const bridge=window.FlowHubPluginIntegration;await bridge.refresh();
 assert.equal(bridge.getSnapshot()[0].manifest.id,'example');
 bridge.show('plugin:example');assert.equal(frame.src,'','script does not query or navigate a nonexistent frame');
 const detach=bridge.attach(frame);bridge.show('plugin:example');
 assert.equal(frame.sandbox,'allow-scripts');assert.match(frame.src,/^flowhub-plugin:\/\/example\/index.html/);
 await listeners.message({source:{},data:{type:'flowhub:request',id:'1',method:'run'}});assert.equal(calls.length,0);
 await listeners.message({source:frame.contentWindow,data:{type:'flowhub:request',id:'1',method:'run',params:{id:'forged'}}});
 assert.equal(calls[0].args.id,'example');assert.equal(responses[0].result.ok,true);
 await listeners.message({source:frame.contentWindow,data:{type:'flowhub:request',id:'status',method:'flowhub_status'}});
 assert.equal(calls[1].method,'plugin_status_api');assert.equal(calls[1].args.id,'example');
 const slow=listeners.message({source:frame.contentWindow,data:{type:'flowhub:request',id:'slow',method:'slow'}});
 bridge.show('extensions');assert.equal(frame.sandbox,undefined);assert.equal(frame.src,'plugin-market.html');gate();await slow;assert.equal(responses.length,2,'no reply delivered after navigation');
 detach();await listeners.message({source:frame.contentWindow,data:{type:'flowhub:request',id:'detached',method:'run'}});assert.equal(calls.length,3);
});
test('React navigation keeps selected market/plugin highlighted after refresh and falls back on disable',async()=>{
 const {store}=await h.loaded();let enabled=true;
 window.__TAURI__.core.invoke=async()=>[{enabled,manifest:{id:'example',name:'Example',ui:'ui/index.html'}}];
 vm.runInNewContext(source,{window,console});await window.FlowHubPluginIntegration.refresh();
 const {Settings}=require('../../src/settings/index.tsx'),view=await h.mount(Settings,{store});
 const selected=()=>[...view.container.querySelectorAll('nav[aria-label="设置模块"] [aria-pressed=true]')].map(b=>b.textContent);
 await h.click(h.button(view.container,'插件市场'));assert.deepEqual(selected(),['插件市场']);
 await h.act(async()=>window.FlowHubPluginIntegration.refresh());assert.deepEqual(selected(),['插件市场']);
 await h.click(h.button(view.container,'Example'));assert.deepEqual(selected(),['Example']);assert.equal(view.container.querySelector('iframe').getAttribute('sandbox'),'allow-scripts');
 await h.act(async()=>window.FlowHubPluginIntegration.refresh());assert.deepEqual(selected(),['Example']);
 enabled=false;await h.act(async()=>window.FlowHubPluginIntegration.refresh());assert.deepEqual(selected(),['插件市场']);
 await h.click(h.button(view.container,'通用设置'));assert.deepEqual(selected(),['通用设置']);assert.equal(view.container.querySelector('iframe'),null);
 await view.unmount();store.dispose();delete window.FlowHubPluginIntegration;
});
