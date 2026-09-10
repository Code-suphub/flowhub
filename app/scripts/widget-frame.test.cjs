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
test('disposed frames cannot receive late backend results',async()=>{
  const s=setup();let finish;const h=s.mount({rpc:()=>new Promise(r=>finish=r)});
  const pending=s.emit({type:'flowhub:widget-rpc',token:s.token(),id:'1'});
  h.dispose();finish('private result');await pending;assert.equal(s.messages.length,0);
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
