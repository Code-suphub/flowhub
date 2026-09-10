const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('installed plugin pages are sandboxed and RPC is scoped to the selected frame',async()=>{
  const listeners={}, calls=[];
  const frame={src:'',contentWindow:{postMessage(value){calls.push(value);}},setAttribute(k,v){this[k]=v;},removeAttribute(k){delete this[k];}};
  const window={addEventListener(k,fn){listeners[k]=fn;},flowhubIcon:()=>'',__TAURI__:{core:{invoke:async(method,args)=>{
    if(method==='plugin_api')return [{enabled:true,manifest:{id:'example',name:'Example',ui:'ui/index.html'}}];
    calls.push(args);return {ok:true};
  }}}};
  const state={module:'core'};
  vm.runInNewContext(fs.readFileSync('ui/plugin-entry.js','utf8'),{window,document:{querySelector:()=>frame},state,renderPluginModules(){},switchModule(m){state.module=m;},console});
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
