const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const app=path.resolve(__dirname,'../..'),bundle=fs.readFileSync(path.join(app,'ui/react/host.js'),'utf8');
const wait=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(predicate(),'detail state did not settle');};
function setup(t,options={}){
  const console=new VirtualConsole(),dom=new JSDOM('<div id="plugin-detail-root"></div>',{url:options.url||'http://localhost/plugin-detail.html',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console});
  const w=dom.window,mounts=[],updates=[],calls=[],disposed=[];
  if(options.invoke)w.__TAURI__={core:{invoke:async(command,args)=>{calls.push({command,args});return options.invoke(command,args);}}};
  if(options.fetch)w.fetch=options.fetch;
  if(options.realBridge)w.eval(fs.readFileSync(path.join(app,'ui/plugin/widget-frame.js'),'utf8'));
  else w.FlowHubWidgetFrame={mount:(frame,config)=>{
    mounts.push({frame,...config});frame.src=config.url+'#flowhubWidgetToken=token-'+mounts.length;
    return{dispose(){disposed.push(config);},updateContext(context){updates.push(context);}};
  }};
  w.eval(bundle);t.after(()=>dom.window.close());
  const button=label=>[...w.document.querySelectorAll('button')].find(node=>node.textContent===label);
  const ready=()=>{const frame=w.document.querySelector('iframe'),token=new URLSearchParams(new URL(frame.src).hash.slice(1)).get('flowhubWidgetToken');w.dispatchEvent(new w.MessageEvent('message',{source:frame.contentWindow,data:{type:'flowhub:widget-ready',token}}));};
  return{dom,w,mounts,updates,calls,disposed,button,ready};
}
const context=(revision,title='详情',config={selection:{row:'a'}})=>({plugin:'bound',url:'flowhub-plugin://bound/detail.html?v=1',context:{title,config,snapshot:{revision}},revision});
test('detail updates reuse the bridge and reject older reads and revisions',async t=>{
  let reads=0,second,third;
  const s=setup(t,{invoke:async(command,args)=>{
    if(args.action!=='detailContext')return null;
    if(++reads===1)return context(1);
    if(reads===2)return new Promise(resolve=>{second=resolve;});
    if(reads===3)return new Promise(resolve=>{third=resolve;});
    return context(2,'更旧版本');
  }});await wait(()=>s.mounts.length===1);s.ready();await wait(()=>!s.w.document.querySelector('[role=status]'));
  s.w.dispatchEvent(new s.w.CustomEvent('flowhub:detail-context-changed'));await wait(()=>second);
  s.w.dispatchEvent(new s.w.CustomEvent('flowhub:detail-context-changed'));await wait(()=>third);
  third(context(3,'最新详情',{selection:{row:'a'},metric:'memory'}));await wait(()=>s.updates.length===1);
  second(context(2,'旧详情'));await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(s.mounts.length,1);assert.equal(s.updates[0].title,'最新详情');assert.equal(s.w.document.querySelector('h1').textContent,'最新详情');
  s.w.dispatchEvent(new s.w.CustomEvent('flowhub:detail-context-changed'));await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(s.updates.length,1);assert.equal(s.w.document.querySelector('h1').textContent,'最新详情');
});
test('old readiness cannot clear a newer context failure, and retry disposes the previous bridge',async t=>{
  let reads=0;
  const s=setup(t,{invoke:async()=>{if(++reads===2)throw Error('context unavailable');return context(reads);}});await wait(()=>s.mounts.length===1);
  s.w.dispatchEvent(new s.w.CustomEvent('flowhub:detail-context-changed'));await wait(()=>s.button('重试加载'));
  s.ready();await new Promise(resolve=>setTimeout(resolve,15));assert.ok(s.w.document.querySelector('[role=alert]'));
  s.button('重试加载').click();await wait(()=>s.mounts.length===2);assert.equal(s.disposed.length,1);
  s.ready();await wait(()=>!s.w.document.querySelector('[role=alert]'));assert.equal(s.w.document.querySelector('iframe').getAttribute('sandbox'),'allow-scripts');
});
test('detail return and close use bound native actions, keep return failures retryable and do not remount',async t=>{
  let returns=0,finishReturn;
  const s=setup(t,{invoke:async(command,args)=>{if(args.action==='detailContext')return context(1);if(args.action==='detailReturn'){if(++returns===1)throw Error('canvas unavailable');return new Promise(resolve=>{finishReturn=resolve;});}return null;}});
  await wait(()=>s.mounts.length===1);s.ready();s.button('返回画布').click();await wait(()=>s.button('重试返回'));
  assert.equal(s.w.document.querySelector('iframe').hidden,false);s.button('重试返回').click();await wait(()=>finishReturn&&s.button('关闭详情').disabled);
  finishReturn(null);await wait(()=>!s.button('关闭详情').disabled);
  s.button('关闭详情').click();await wait(()=>s.calls.some(call=>call.args.action==='detailClose'));
  assert.equal(s.mounts.length,1);assert.ok(s.calls.filter(call=>['detailReturn','detailClose'].includes(call.args.action)).every(call=>Object.keys(call.args.payload).length===0));
});
test('browser failures offer retry and a safe canvas return while successful previews have no native RPC',async t=>{
  let available=false,requested;
  const s=setup(t,{url:'http://localhost/plugin-detail.html?preview=http%3A%2F%2Flocalhost%2Fdemo&config=%7B%22row%22%3A%22a%22%7D&returnTo=https%3A%2F%2Fevil.test%2Fplugin-canvas.html',fetch:async url=>{requested=String(url);if(!available)throw Error('offline');return{ok:true,json:async()=>({id:'preview',widget:{detail:'detail.html'},snapshot:{cpu:1}})};}});
  await wait(()=>s.button('重试加载'));assert.ok(s.button('返回画布'));assert.match(s.w.document.body.textContent,/预览服务已启动/);
  available=true;s.button('重试加载').click();await wait(()=>s.mounts.length===1);assert.equal(requested,'http://localhost/demo/widget-preview.json');
  assert.equal(s.mounts[0].rpc,null);assert.equal(s.mounts[0].context.preview,true);assert.equal(s.mounts[0].url,'http://localhost/demo/detail.html');
  s.button('返回画布').click();assert.equal(s.calls.length,0);
});
test('the real sandbox bridge rejects foreign RPC and binds authenticated requests to its native owner',async t=>{
  const s=setup(t,{realBridge:true,invoke:async(command,args)=>command==='plugin_canvas_api'?context(1):{ok:true}});
  await wait(()=>s.w.document.querySelector('iframe')?.src.includes('flowhubWidgetToken'));
  const frame=s.w.document.querySelector('iframe'),token=new URLSearchParams(new URL(frame.src).hash.slice(1)).get('flowhubWidgetToken');
  s.w.dispatchEvent(new s.w.MessageEvent('message',{source:s.w,data:{type:'flowhub:widget-rpc',token,id:'foreign',params:{id:'evil'}}}));
  s.w.dispatchEvent(new s.w.MessageEvent('message',{source:frame.contentWindow,data:{type:'flowhub:widget-rpc',token,id:'valid',params:{id:'evil'}}}));
  await wait(()=>s.calls.some(call=>call.command==='plugin_widget_rpc'));
  const rpc=s.calls.filter(call=>call.command==='plugin_widget_rpc');assert.equal(rpc.length,1);assert.equal(rpc[0].args.id,'bound');assert.equal(frame.getAttribute('sandbox'),'allow-scripts');
});
test('browser navigation helpers preserve canvas context and reject external return targets',()=>{
  // Load this small pure helper without changing the application's build entry.
  const ts=require('typescript'),source=fs.readFileSync(path.join(app,'src/canvas/detail-navigation.ts'),'utf8'),exports={};
  new Function('exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(exports);
  const current='http://localhost/plugin-canvas.html?preview=http%3A%2F%2Flocalhost%2Fdemo%2F&custom=kept';
  const detail=new URL(exports.browserDetailUrl(current,'http://localhost/demo/','board','card',{selection:{id:'x'}},'详情','bound'));
  const back=new URL(detail.searchParams.get('returnTo'));assert.equal(back.searchParams.get('custom'),'kept');assert.equal(back.searchParams.get('board'),'board');assert.equal(back.searchParams.get('card'),'card');assert.equal(back.searchParams.get('returnPlugin'),'bound');
  assert.equal(exports.canvasReturnUrl('https://evil.test/plugin-canvas.html',detail.href),'http://localhost/plugin-canvas.html');
  assert.throws(()=>exports.previewDetailUrl('https://evil.test/detail.html',new URL('http://localhost/demo/')));
});
