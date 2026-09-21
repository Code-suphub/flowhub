const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('installed plugin pages are sandboxed and RPC is scoped to the selected frame',async()=>{
  const listeners={}, calls=[];
  const frame={src:'',contentWindow:{postMessage(value){calls.push(value);}},setAttribute(k,v){this[k]=v;},removeAttribute(k){delete this[k];}};
  const window={addEventListener(k,fn){listeners[k]=fn;},flowhubIcon:()=>'',__TAURI__:{core:{invoke:async(method,args)=>{
    if(method==='plugin_api')return [{enabled:true,manifest:{id:'example',name:'Example',ui:'ui/index.html'}}];
    calls.push(args);return {ok:true};
  }}}};
  const state={module:'core'};
  vm.runInNewContext(fs.readFileSync('ui/plugin/plugin-entry.js','utf8'),{window,document:{querySelector:()=>frame},state,renderPluginModules(){},switchModule(m){state.module=m;},console});
  await new Promise(r=>setImmediate(r));
  const integration=window.FlowHubPluginIntegration;
  assert(integration.has('plugin:example'));assert(!integration.has('plugin:missing'));
  integration.show('plugin:example');
  assert.equal(frame.sandbox,'allow-scripts');assert.match(frame.src,/^flowhub-plugin:\/\/example\/index.html/);
  await listeners.message({source:{},data:{type:'flowhub:request',id:'1',method:'run'}});
  assert.equal(calls.length,0);
  await listeners.message({source:frame.contentWindow,data:{type:'flowhub:request',id:'1',method:'run',params:{}}});
  assert.equal(calls[0].id,'example');assert.equal(calls[1].result.ok,true);
  integration.show('extensions');assert.equal(frame.sandbox,undefined);
});

test('navigation keeps the selected market or plugin highlighted after refresh',async()=>{
  const state={module:'extensions'};
  let navigation='';
  const window={addEventListener(){},flowhubIcon:()=>'',__TAURI__:{core:{invoke:async()=>[
    {enabled:true,manifest:{id:'example',name:'Example',ui:'ui/index.html'}}
  ]}}};
  vm.runInNewContext(fs.readFileSync('ui/plugin/plugin-entry.js','utf8'),{
    window,document:{querySelector:()=>({})},state,console,
    renderPluginModules(){navigation=window.FlowHubPluginIntegration.navigation();},
    switchModule(module){state.module=module;}
  });
  const selected=()=>[...navigation.matchAll(/<button class="module-button active"[^>]*data-module="([^"]+)" aria-pressed="true"/g)].map(match=>match[1]);
  await window.FlowHubPluginIntegration.refresh();
  assert.deepEqual(selected(),['extensions']);
  state.module='plugin:example';
  await window.FlowHubPluginIntegration.refresh();
  assert.deepEqual(selected(),['plugin:example']);
  state.module='core';
  await window.FlowHubPluginIntegration.refresh();
  assert.deepEqual(selected(),[]);
  assert.equal((navigation.match(/aria-pressed="false"/g)||[]).length,2);
});
