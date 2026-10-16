const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait}=require('./widget-canvas-react.test.cjs');
const source={id:'service',title:'状态组件',snapshot:{rows:[{id:'a',status:'error',values:{cpu:90}}]},widget:{card:'card.html',editor:'editor.html'}};
const layout=()=>({active:'first',pinned:false,layoutLocked:true,viewOnly:false,boards:[{id:'first',title:'主要布局',cards:[{id:'one',plugin:'service',title:'接口',config:{row:'a'},width:200,height:184,x:0,y:0}]}]});
const presentation=(overrides={})=>({enabled:true,collapsed:false,favorites:[{boardId:'first',cardId:'one'}],revision:1,...overrides});

test('compact demo switches, configures favorites and returns without native calls, fetches, frames or storage writes',async t=>{
  let requests=0;
  const s=setup(t,{preview:'demo',fetch:()=>{requests++;throw Error('demo must not fetch');}}),before=s.w.localStorage.getItem('flowhub-canvas-preview');
  await wait(()=>s.w.document.getElementById('expandCanvas'));
  assert.equal(s.w.document.querySelectorAll('.compact-favorite').length,3);assert.match(s.w.document.querySelector('.canvas-compact-bar').textContent,/正常/);assert.match(s.w.document.querySelector('.canvas-compact-bar').textContent,/异常/);
  assert.equal(s.w.document.querySelectorAll('iframe').length,0);
  assert.equal(s.w.document.querySelector('.compact-favorites').tabIndex,0);
  const menu=s.w.document.querySelector('[aria-label="更多状态条操作"]');menu.click();await wait(()=>s.w.document.querySelector('.compact-action-menu'));
  assert.ok([...s.w.document.querySelectorAll('.compact-action-menu [role^=menuitem]')].every(item=>item.getAttribute('aria-disabled')==='true'));
  s.w.document.querySelector('.compact-action-menu').dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!s.w.document.querySelector('.compact-action-menu'));
  s.w.document.getElementById('expandCanvas').click();await wait(()=>s.w.document.querySelectorAll('.canvas-demo-card').length===3);
  s.w.document.getElementById('canvasMore').click();await wait(()=>s.button('紧凑状态条'));s.button('紧凑状态条').click();await wait(()=>s.w.document.querySelector('.canvas-compact-settings'));
  const checkbox=s.w.document.querySelector('[role=checkbox]');checkbox.click();await wait(()=>checkbox.getAttribute('aria-checked')==='false');s.button('保存').click();await wait(()=>!s.w.document.querySelector('.canvas-compact-settings'));
  s.w.document.getElementById('collapseCanvas').click();await wait(()=>s.w.document.querySelectorAll('.compact-favorite').length===2);
  assert.equal(s.w.localStorage.getItem('flowhub-canvas-preview'),before);assert.equal(requests,0);assert.equal(s.calls.length,0);assert.equal(s.w.document.querySelectorAll('iframe').length,0);
});

test('compact mode preserves layout and restrictions, ignores stale presentation polls and restores full canvas',async t=>{
  const saved=layout(),state=presentation();
  const s=setup(t,{layout:saved,sources:[source],invoke:(command,args)=>{
    if(args.action==='get')return Promise.resolve({layout:saved,sources:[source],presentation:state});
    if(args.action==='setCompact')return Promise.resolve({presentation:presentation({collapsed:args.payload.collapsed,revision:args.payload.collapsed?2:3})});
  }});
  await wait(()=>s.w.document.getElementById('collapseCanvas'));
  await new Promise(resolve=>setTimeout(resolve,20));const fits=s.calls.filter(call=>call.action==='fit').length;
  s.w.document.getElementById('collapseCanvas').click();await wait(()=>s.w.document.getElementById('expandCanvas'));
  assert.match(s.w.document.querySelector('.compact-favorites').textContent,/异常/);assert.equal(s.w.document.querySelectorAll('iframe').length,0);
  s.w.document.querySelector('[aria-label="更多状态条操作"]').click();await wait(()=>s.calls.some(call=>call.action==='compactMenu'));
  assert.equal(s.w.document.querySelector('.fh-canvas-app').dataset.layoutLocked,'true');
  for(const interval of s.intervals)if(interval.ms===15000)await interval.callback();
  await new Promise(resolve=>setTimeout(resolve,10));assert.ok(s.w.document.getElementById('expandCanvas'),'old poll cannot undo the newer mode');
  s.w.document.getElementById('expandCanvas').click();await wait(()=>s.w.document.querySelector('[data-id=one]'));
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(s.calls.filter(call=>call.action==='fit').length,fits,'restoring full mode must not immediately fit over the saved full window geometry');
  assert.equal(s.w.document.getElementById('add').disabled,true);assert.equal(s.w.document.querySelector('.fh-canvas-app').dataset.layoutLocked,'true');
  assert.equal(s.calls.filter(call=>call.action==='save').length,0);assert.deepEqual(saved,layout());
});

test('collapsing cancels an unfinished gesture and preserves the original card geometry',async t=>{
  const saved={...layout(),layoutLocked:false};
  const s=setup(t,{layout:saved,sources:[source],invoke:(command,args)=>{
    if(args.action==='get')return Promise.resolve({layout:saved,sources:[source],presentation:presentation()});
    if(args.action==='setCompact')return Promise.resolve({presentation:presentation({collapsed:args.payload.collapsed,revision:args.payload.collapsed?2:3})});
  }});
  await wait(()=>s.w.document.querySelector('.widget-hit'));
  const node=s.w.document.querySelector('.canvas-card');s.pointer(node.querySelector('.widget-hit'),'pointerdown',10,10);s.pointer(node,'pointermove',110,90);assert.equal(node.style.left,'100px');
  s.w.document.getElementById('collapseCanvas').click();await wait(()=>s.w.document.getElementById('expandCanvas'));
  s.w.document.getElementById('expandCanvas').click();await wait(()=>s.w.document.querySelector('.canvas-card'));
  assert.equal(s.w.document.querySelector('.canvas-card').style.left,'0px');assert.equal(s.calls.filter(call=>call.action==='save').length,0);
});

test('restored full geometry blocks only startup fit, including the pending initial get, and later edits still fit',async t=>{
  let resolveGet;
  const saved={...layout(),layoutLocked:false};
  saved.boards[0].cards[0].width=384;
  const s=setup(t,{layout:saved,sources:[source],invoke:(command,args)=>args.action==='get'?new Promise(resolve=>resolveGet=resolve):undefined});
  await wait(()=>resolveGet);await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(s.calls.filter(call=>call.action==='fit').length,0,'an unloaded canvas must not resize the restored native window');
  resolveGet({layout:saved,sources:[source],presentation:presentation(),windowGeometryRestored:true});
  await wait(()=>s.w.document.querySelector('[data-resize]'));await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(s.calls.filter(call=>call.action==='fit').length,0,'first loaded fit preserves restored full dimensions');
  s.w.document.querySelector('[data-resize]').dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  await wait(()=>s.calls.some(call=>call.action==='save'));await wait(()=>s.calls.some(call=>call.action==='fit'));
  assert.equal(s.calls.filter(call=>call.action==='fit').length,1,'a later explicit content size change still fits');
});

test('failed compact mutation stays expanded and rapid retries submit once until the acknowledgement',async t=>{
  let attempts=0,resolve;
  const s=setup(t,{layout:layout(),sources:[source],invoke:(command,args)=>{
    if(args.action==='get')return Promise.resolve({layout:layout(),sources:[source],presentation:presentation()});
    if(args.action==='setCompact'){attempts++;return attempts===1?Promise.reject(Error('disk unavailable')):new Promise(done=>resolve=done);}
  }});
  await wait(()=>s.w.document.getElementById('collapseCanvas'));
  s.w.document.getElementById('collapseCanvas').click();await wait(()=>s.w.document.getElementById('notice').textContent.includes('disk unavailable'));
  assert.ok(s.w.document.querySelector('[data-id=one]'));assert.equal(s.w.document.getElementById('expandCanvas'),null);
  s.w.document.getElementById('collapseCanvas').click();s.w.document.getElementById('collapseCanvas').click();await wait(()=>resolve);assert.equal(attempts,2);
  s.w.dispatchEvent(new s.w.CustomEvent('flowhub:canvas-presentation',{detail:presentation({collapsed:false,revision:5})}));
  resolve({presentation:presentation({collapsed:true,revision:2})});await wait(()=>!s.w.document.getElementById('collapseCanvas').disabled);
  assert.ok(s.w.document.querySelector('[data-id=one]'));assert.equal(s.w.document.getElementById('expandCanvas'),null,'older acknowledgement cannot override a newer external mode');
});

test('view-only compact presentation keeps an accessible route back without changing interaction mode',async t=>{
  const saved={...layout(),viewOnly:true};
  const s=setup(t,{layout:saved,sources:[source],invoke:(command,args)=>{
    if(args.action==='get')return Promise.resolve({layout:saved,sources:[source],presentation:presentation({collapsed:true})});
    if(args.action==='setCompact')return Promise.resolve({presentation:presentation({revision:2})});
  }});
  await wait(()=>s.w.document.getElementById('expandCanvas'));assert.equal(s.w.document.getElementById('expandCanvas').disabled,false);
  s.w.document.getElementById('expandCanvas').click();await wait(()=>s.button('收起为状态条'));
  await wait(()=>s.w.document.activeElement===s.button('收起为状态条'));
  assert.equal(s.w.document.querySelector('.fh-canvas-app').dataset.viewOnly,'true');assert.equal(s.w.document.querySelector('.canvas-view-only-compact').closest('[inert]'),null);
});

test('generic compact status respects declared state, missing data, errors and board-scoped favorites',()=>{
  const {buildSync}=require('esbuild'),vm=require('node:vm'),path=require('node:path');
  const bundle=buildSync({entryPoints:[path.join(__dirname,'../../src/canvas/compact-model.ts')],bundle:true,write:false,format:'iife',globalName:'CompactModel'}).outputFiles[0].text;
  const context=vm.createContext({});vm.runInContext(bundle,context);const model=context.CompactModel,card={id:'one',plugin:'generic',config:{row:'row'}};
  assert.equal(model.compactStatus(card,{snapshot:{rows:[{id:'row',status:'healthy',values:{cpu:NaN,memory:Infinity}}]}}).metric,'指标 —');
  assert.equal(model.compactStatus(card,{snapshot:{rows:[{id:'row',status:'future-state',values:{cpu:0}}]}}).status,'unknown');
  assert.equal(model.compactStatus(card,{snapshot:{error:'failed',rows:[{id:'row',status:'healthy'}]}}).status,'error');
  assert.equal(model.compactStatus(card,{snapshot:{rows:[]}}).status,'unknown');assert.equal(model.compactStatus(card).label,'插件不可用');
  const saved=layout();saved.boards.push({id:'other',title:'其他',cards:[{...saved.boards[0].cards[0],title:'不同对象'}]});
  assert.equal(model.favoriteCards(saved,[{boardId:'other',cardId:'one'}])[0].card.title,'不同对象');
  assert.equal(model.favoriteCards(saved,[{boardId:'deleted',cardId:'one'}]).length,0);
});
