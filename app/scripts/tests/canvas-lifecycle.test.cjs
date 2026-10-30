const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {setup,ready,wait}=require('./widget-canvas-react.test.cjs');
const {installCanvasClock}=require('./canvas-clock.cjs');
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
const lifecycle=(s,active,revision)=>s.w.dispatchEvent(new s.w.CustomEvent('flowhub:canvas-lifecycle',{detail:{active,revision}}));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const actions=(s,action)=>s.calls.filter(call=>call.action===action).length;

test('native visibility owns refresh budgets, preserves document-hidden desktop updates, and compact stops only cursor work',async t=>{
  let clock;const s=setup(t,{installClock:w=>clock=installCanvasClock(w)});await ready(s);
  Object.defineProperty(s.w.document,'hidden',{configurable:true,value:true});s.w.document.dispatchEvent(new s.w.Event('visibilitychange'));
  let get=actions(s,'get'),cursor=actions(s,'cursor');await clock.advance(60000);
  assert.equal(actions(s,'get')-get,4);assert.equal(actions(s,'cursor')-cursor,400);
  const old=s.w.document.querySelector('.widget-content');s.frameMessages(old);
  lifecycle(s,false,1);await wait(()=>s.responses.some(message=>message.type==='flowhub:widget-lifecycle'&&!message.active));assert.equal(s.w.document.querySelector('.widget-content'),old);get=actions(s,'get');cursor=actions(s,'cursor');await clock.advance(60000);
  assert.equal(actions(s,'get'),get);assert.equal(actions(s,'cursor'),cursor);assert.deepEqual(clock.pending(),[]);
  s.message(old,{type:'flowhub:widget-ready'});await tick();assert.equal(s.responses.filter(message=>message.type==='flowhub:widget-init').length,0);
  lifecycle(s,true,2);await ready(s);assert.equal(s.w.document.querySelector('.widget-content'),old);
  s.w.dispatchEvent(new s.w.CustomEvent('flowhub:canvas-presentation',{detail:{enabled:true,collapsed:true,favorites:[],revision:3}}));await wait(()=>s.w.document.getElementById('expandCanvas'));await tick();
  get=actions(s,'get');cursor=actions(s,'cursor');await clock.advance(60000);
  assert.equal(actions(s,'get')-get,4);assert.equal(actions(s,'cursor'),cursor);assert.equal(s.w.document.querySelector('iframe'),null);
  s.w.document.querySelector('[aria-label="更多状态条操作"]').click();await wait(()=>actions(s,'compactMenu')===1);
  s.w.dispatchEvent(new s.w.CustomEvent('flowhub:canvas-presentation',{detail:{enabled:true,collapsed:false,favorites:[],revision:4}}));await ready(s);await tick();assert.ok(clock.pending().includes(150));
  s.w.dispatchEvent(new s.w.Event('pagehide'));await tick();assert.deepEqual(clock.pending(),[]);
});

test('an old in-flight cursor cannot revive a second polling loop after hide/show',async t=>{
  let clock;const first=deferred(),second=deferred();let count=0;
  const s=setup(t,{installClock:w=>clock=installCanvasClock(w),invoke:(command,args)=>args.action==='cursor'?(++count===1?first.promise:count===2?second.promise:Promise.resolve({x:20,y:20})):undefined});await ready(s);
  lifecycle(s,false,1);lifecycle(s,true,2);await wait(()=>count===2);
  first.resolve({x:-20,y:-20});second.resolve({x:20,y:20});await tick();
  assert.equal(clock.pending().filter(ms=>ms===150).length,1);await clock.advance(600);assert.equal(count,6);
});

test('resume rejects stale cache responses and preserves the original frame through slow or failed refreshes',async t=>{
  let pending=null;const s=setup(t,{invoke:(command,args)=>args.action==='get'&&pending?pending.promise:undefined});await ready(s);
  const old=s.w.document.querySelector('.canvas-card'),frame=old.querySelector('iframe'),src=frame.src;old.focus();const stale=deferred();pending=stale;
  s.intervals[0].callback();await tick();lifecycle(s,false,1);const fresh=deferred();pending=fresh;lifecycle(s,true,2);await tick();
  assert.equal(s.w.document.querySelector('.widget-content'),frame);assert.equal(frame.src,src);
  fresh.reject(Error('cache unavailable'));await wait(()=>s.button('重试更新组件'));
  assert.ok(s.w.document.querySelector('[data-id=one]'));assert.equal(s.w.document.querySelector('.widget-content'),frame);
  stale.resolve({layout:{active:'gone',boards:[]},sources:[],lifecycle:{active:false,revision:1}});await tick();assert.ok(s.button('重试更新组件'));
  pending=null;s.button('重试更新组件').click();await wait(()=>!s.w.document.querySelector('.canvas-refresh-error'));assert.equal(s.w.document.querySelector('.widget-content'),frame);
});

test('initial cache cannot override newer hide/show events and pageshow probes a missed native resume',async t=>{
  const initial=deferred();let first=true;const s=setup(t,{invoke:(command,args)=>{
    if(args.action==='get'&&first){first=false;return initial.promise;}
    if(args.action==='lifecycle')return Promise.resolve({lifecycle:{active:true,revision:5}});
  }});await wait(()=>actions(s,'get')===1);lifecycle(s,false,1);lifecycle(s,true,2);await ready(s);
  initial.resolve({layout:{active:'bad',boards:[]},sources:[],lifecycle:{active:false,revision:1}});await tick();assert.ok(s.w.document.querySelector('.widget-content'));
  lifecycle(s,false,3);s.w.dispatchEvent(new s.w.Event('pagehide'));s.w.dispatchEvent(new s.w.Event('pageshow'));s.w.dispatchEvent(new s.w.Event('pageshow'));await ready(s);
  assert.equal(actions(s,'lifecycle'),1);lifecycle(s,false,4);await tick();assert.ok(s.w.document.querySelector('.widget-content'),'stale native event cannot undo the probe');
});

test('hidden editor keeps its draft, bridge and in-flight save across a plugin version refresh',async t=>{
  const s=setup(t);await ready(s);s.w.document.querySelector('.canvas-card').dispatchEvent(new s.w.MouseEvent('contextmenu',{bubbles:true,clientX:20,clientY:20}));await wait(()=>s.button('编辑组件'));s.button('编辑组件').click();
  await wait(()=>s.w.document.getElementById('widgetEditor')?.src.includes('flowhubWidgetToken'));const frame=s.w.document.getElementById('widgetEditor'),src=frame.src;s.frameMessages(frame);s.message(frame,{type:'flowhub:widget-ready'});await wait(()=>!s.w.document.querySelector('button[form=widgetForm]').disabled);
  s.input(s.w.document.getElementById('cardTitle'),'未保存草稿');await tick();s.submit('widgetForm');await wait(()=>s.responses.some(message=>message.type==='flowhub:widget-save'));const save=s.responses.find(message=>message.type==='flowhub:widget-save');
  lifecycle(s,false,1);await tick();assert.equal(s.w.document.getElementById('widgetEditor'),frame);assert.equal(s.w.document.getElementById('cardTitle').value,'未保存草稿');
  s.data.sources[0].lastLoadedAt=456;s.data.sources[0].snapshot={count:9};lifecycle(s,true,2);await wait(()=>s.w.document.body.textContent.includes('插件已变更'));
  assert.equal(s.w.document.getElementById('widgetEditor'),frame);assert.equal(frame.src,src);assert.equal(s.responses.filter(message=>message.type==='flowhub:widget-init').length,1);
  s.message(frame,{type:'flowhub:widget-config',id:save.id,config:{draft:true}});await wait(()=>s.calls.some(call=>call.action==='save'));
  const saved=s.calls.find(call=>call.action==='save').payload;assert.equal(saved.boards[0].cards[0].title,'未保存草稿');assert.deepEqual(saved.boards[0].cards[0].config,{draft:true});assert.equal(actions(s,'save'),1);
});

test('canvas-owned portal controls receive the reduced-motion policy without hiding focus or disabling interaction',async t=>{
  const s=setup(t);await ready(s);s.w.document.getElementById('canvasMore').click();await wait(()=>s.button('新建布局'));s.button('新建布局').click();await wait(()=>s.w.document.querySelector('.fh-dialog'));
  assert.equal(s.w.document.getElementById('canvas-root').contains(s.w.document.querySelector('.fh-dialog')),false);
  const css=fs.readFileSync(path.join(__dirname,'../../src/canvas/canvas.css'),'utf8');
  assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)/);assert.match(css,/body:has\(#canvas-root\) :is\(\.fh-dialog, \.compact-action-menu\)/);assert.match(css,/transition:\s*none\s*!important/);assert.doesNotMatch(css,/pointer-events:\s*none[^}]*prefers-reduced-motion/);
});
