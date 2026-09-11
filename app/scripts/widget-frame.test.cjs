const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup(){
  const listeners=new Set(),messages=[];let serial=0;
  const window={addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../ui/widget-frame.js'),'utf8'),{window,URL,URLSearchParams,location:{href:'https://host/'},crypto:{randomUUID:()=>String(++serial)},setTimeout,clearTimeout});
  const frame={isConnected:true,contentWindow:{postMessage:m=>messages.push(m)},setAttribute(k,v){this[k]=v;}};
  return {frame,messages,mount:options=>window.FlowHubWidgetFrame.mount(frame,{url:'https://plugin/card.html',context:{},...options}),async emit(data,source=frame.contentWindow){await Promise.all([...listeners].map(fn=>fn({source,data})));},token:()=>new URL(frame.src).hash.split('=')[1]};
}
test('RPC is bound to one frame and mount, including reused iframe navigation',async()=>{
  const s=setup();let calls=0;
  const old=s.mount({rpc:async()=>++calls}),oldToken=s.token();
  assert.equal(s.frame.sandbox,'allow-scripts');
  await s.emit({type:'flowhub:widget-rpc',token:oldToken,id:'1'},{});
  assert.equal(calls,0);old.dispose();
  const current=s.mount({rpc:async()=>++calls});
  await s.emit({type:'flowhub:widget-rpc',token:oldToken,id:'1'});
  assert.equal(calls,0);
  await s.emit({type:'flowhub:widget-rpc',token:s.token(),id:'1',plugin:'other-plugin'});
  assert.equal(calls,1);assert.equal(s.messages.at(-1).result,1);current.dispose();
});
test('navigation only accepts the bound frame and allowed destinations',async()=>{
  const s=setup(),actions=[],h=s.mount({navigate:action=>actions.push(action)}),token=s.token();
  await s.emit({type:'flowhub:widget-navigate',token,action:'detail'},{});
  await s.emit({type:'flowhub:widget-navigate',token:'wrong',action:'editor'});
  await s.emit({type:'flowhub:widget-navigate',token,action:'shell'});
  assert.deepEqual(actions,[]);
  await s.emit({type:'flowhub:widget-navigate',token,action:'detail',plugin:'other'});
  await s.emit({type:'flowhub:widget-navigate',token,action:'editor'});
  assert.deepEqual(actions,['detail','editor']);h.dispose();
});
test('disposed frames cannot receive late backend results',async()=>{
  const s=setup();let finish;const h=s.mount({rpc:()=>new Promise(r=>finish=r)});
  const pending=s.emit({type:'flowhub:widget-rpc',token:s.token(),id:'1'});
  h.dispose();finish('private result');await pending;assert.equal(s.messages.length,0);
});
test('object navigation carries bounded selection without accepting oversized payloads',async()=>{
  const s=setup(),received=[],h=s.mount({navigate:(action,selection)=>received.push({action,selection})}),token=s.token();
  await s.emit({type:'flowhub:widget-navigate',token,action:'detail',selection:{kind:'container',id:'a'.repeat(64)}});
  assert.equal(received[0].selection.id,'a'.repeat(64));
  for(const selection of [[],null,'url',{id:'x'.repeat(4097)}])await s.emit({type:'flowhub:widget-navigate',token,action:'detail',selection});
  assert.equal(received.length,1);h.dispose();
});
test('editor validates configuration and rejects oversized data',async()=>{
  const s=setup(),h=s.mount({});
  const saved=h.save(),id=s.messages.at(-1).id;
  await s.emit({type:'flowhub:widget-config',token:s.token(),id,config:{metrics:['cpu']}});
  assert.deepEqual(await saved,{metrics:['cpu']});
  const invalid=h.save(),rejected=assert.rejects(invalid,/组件配置无效/);
  await s.emit({type:'flowhub:widget-config',token:s.token(),id:s.messages.at(-1).id,config:{text:'x'.repeat(65537)}});
  await rejected;h.dispose();
});
test('snapshot updates retain the iframe and in-flight RPC identity',async()=>{
  const s=setup();let finish;const h=s.mount({rpc:()=>new Promise(r=>finish=r)}),src=s.frame.src,token=s.token();
  const pending=s.emit({type:'flowhub:widget-rpc',token,id:'operation'});
  h.updateContext({snapshot:{rows:[{id:'fresh'}]}});assert.equal(s.frame.src,src);assert.equal(s.messages.at(-1).context.snapshot.rows[0].id,'fresh');
  finish({ok:true});await pending;assert.equal(s.messages.at(-1).id,'operation');h.dispose();
});
