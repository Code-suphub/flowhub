const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup(){
  const listeners=new Set(),messages=[];let serial=0;
  const window={addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../../ui/plugin/widget-frame.js'),'utf8'),{window,URL,URLSearchParams,location:{href:'https://host/'},crypto:{randomUUID:()=>String(++serial)},setTimeout,clearTimeout});
  const frame={isConnected:true,contentWindow:{postMessage:m=>messages.push(m)},setAttribute(k,v){this[k]=v;}};
  return {frame,messages,mount:options=>window.FlowHubWidgetFrame.mount(frame,{url:'https://plugin/card.html',context:{},...options}),async emit(data,source=frame.contentWindow){await Promise.all([...listeners].map(fn=>fn({source,data})));},token:()=>new URLSearchParams(new URL(frame.src).hash.slice(1)).get('flowhubWidgetToken')};
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
test('only authenticated bounded editor measurements can resize a surface',async()=>{
  const s=setup(),heights=[],h=s.mount({resize:height=>heights.push(height)}),token=s.token();
  await s.emit({type:'flowhub:widget-size',token,height:384},{});
  await s.emit({type:'flowhub:widget-size',token:'foreign',height:384});
  for(const height of [0,-1,2001,Infinity,NaN,'384'])await s.emit({type:'flowhub:widget-size',token,height});
  assert.deepEqual(heights,[]);
  await s.emit({type:'flowhub:widget-size',token,height:384.2});
  assert.deepEqual(heights,[385]);
  h.dispose();await s.emit({type:'flowhub:widget-size',token,height:400});
  assert.deepEqual(heights,[385]);
});
test('persistent cards pause RPC without queuing actions, preserve identity and resume with the latest context',async()=>{
  const s=setup();let calls=0;const h=s.mount({persistent:true,rpc:async()=>++calls}),token=s.token(),src=s.frame.src;
  h.setActive(false);h.updateContext({snapshot:{count:2}});
  assert.deepEqual({...s.messages.at(-1)},{type:'flowhub:widget-lifecycle',active:false,token});
  await s.emit({type:'flowhub:widget-ready',token});
  assert.equal(s.messages.at(-1).type,'flowhub:widget-lifecycle');
  await s.emit({type:'flowhub:widget-rpc',token,id:'hidden'});
  assert.equal(calls,0);assert.match(s.messages.at(-1).error,/暂停/);
  h.setActive(true);assert.equal(s.frame.src,src);assert.equal(s.messages.at(-1).context.snapshot.count,2);
  assert.equal(calls,0,'hidden actions must never be replayed after resume');
  await s.emit({type:'flowhub:widget-rpc',token,id:'visible'});assert.equal(calls,1);h.dispose();
});

function timerSurface(managed=true){
  let time=0,serial=0;const tasks=new Map(),listeners=new Set(),parent={},activity=[];
  const schedule=(callback,ms=0,...args)=>{const id=++serial;tasks.set(id,{at:time+Number(ms),callback:()=>callback(...args)});return id;};
  const w={setTimeout:schedule,setInterval:schedule,clearTimeout:id=>tasks.delete(id),clearInterval:id=>tasks.delete(id),addEventListener:(type,fn)=>{if(type==='message')listeners.add(fn);},dispatchEvent:event=>activity.push(event.detail.active)};
  const original=w.setTimeout;
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../../ui/plugin/widget-lifecycle.js'),'utf8'),{window:w,parent,location:{hash:`#flowhubWidgetToken=bound${managed?'&flowhubWidgetLifecycle=1':''}`},URLSearchParams,performance:{now:()=>time},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},Reflect});
  return {w,original,activity,pending:()=>tasks.size,change:(active,source=parent,token='bound')=>{for(const fn of listeners)fn({source,data:{type:'flowhub:widget-lifecycle',active,token}});},advance:ms=>{
    const end=time+ms;let count=0;
    while(true){const next=[...tasks].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;if(++count>1000)throw Error('timer backlog');const[id,task]=next;time=task.at;tasks.delete(id);task.callback();}
    time=end;
  }};
}
test('card timers freeze across long occlusion, preserve timeout budgets and never replay missed intervals',()=>{
  const s=timerSurface(),seen=[];
  const interval=s.w.setInterval(function(value){assert.equal(this,s.w);seen.push(value);},5000,'poll');
  s.w.setTimeout(()=>seen.push('deadline'),10000);
  s.advance(2000);s.change(false);assert.equal(s.pending(),0);s.advance(180000);assert.deepEqual(seen,[]);
  s.change(true);s.change(true);assert.equal(s.pending(),2);
  s.advance(4999);assert.deepEqual(seen,[]);s.advance(1);assert.deepEqual(seen,['poll']);
  s.advance(3000);assert.deepEqual(seen,['poll','deadline']);s.w.clearTimeout(interval);s.advance(60000);assert.equal(seen.length,2);
  assert.deepEqual(s.activity,[false,true]);
});
test('timers created and cancelled while suspended stay cancelled and foreign lifecycle messages cannot resume them',()=>{
  const s=timerSurface();let called=0;s.change(false);
  const timeout=s.w.setTimeout(()=>called++,100),interval=s.w.setInterval(()=>called++,100);
  s.w.clearInterval(timeout);s.w.clearTimeout(interval);s.w.setTimeout(()=>called++,50);
  s.change(true,{});s.change(true,undefined,'wrong');s.advance(60000);assert.equal(called,0);assert.equal(s.pending(),0);
  s.change(true);s.advance(49);assert.equal(called,0);s.advance(1);assert.equal(called,1);
});
test('a callback can suspend or cancel its own interval without producing a second timer on resume',()=>{
  const s=timerSurface();let calls=0;
  const interval=s.w.setInterval(()=>{calls++;s.change(false);},100);
  s.advance(100);assert.equal(calls,1);assert.equal(s.pending(),0);s.change(true);assert.equal(s.pending(),1);
  s.advance(100);assert.equal(calls,2);s.w.clearInterval(interval);s.change(true);assert.equal(s.pending(),0);
});
test('panels, editors and detail pages keep native timer APIs',()=>{
  const s=timerSurface(false);assert.equal(s.w.setTimeout,s.original);
});
