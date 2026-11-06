const {test}=require('node:test'),assert=require('node:assert/strict');
const h=require('./settings-harness.test.cjs'),{CanvasSettings}=require('../../src/settings/CanvasSettings.tsx');
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const switchFor=(view,name)=>view.container.querySelector(`[role=switch][aria-label="${name}"]`);

test('failed reads retry once, validate replies and retain newer native mode events',async()=>{
  h.environment();let reads=0;const waiting=gate(),calls=[];
  window.__TAURI__.core.invoke=async(command,args)=>{calls.push(args.action);reads++;if(reads===1)throw Error('临时读取失败');if(reads===2)return {layout:null};return waiting.promise;};
  const view=await h.mount(CanvasSettings,{});assert.match(view.container.querySelector('[role=alert]').textContent,/临时读取失败/);assert.equal(switchFor(view,'锁定布局').getAttribute('aria-disabled'),'true');
  await h.click(view.container.querySelector('[aria-label="重新读取组件设置"]'));assert.match(view.container.querySelector('[role=alert]').textContent,/格式无效/);
  await h.click(view.container.querySelector('[aria-label="重新读取组件设置"]'));assert.match(view.container.textContent,/正在读取组件设置/);assert.equal(h.button(view.container,'打开桌面组件').disabled,true);
  await h.act(async()=>view.container.querySelector('[aria-label="重新读取组件设置"]')?.click());assert.equal(reads,3);
  await h.act(async()=>window.dispatchEvent(new window.CustomEvent('flowhub:canvas-layout-locked',{detail:true})));await h.act(async()=>waiting.resolve({layout:{viewOnly:false,layoutLocked:false}}));
  assert.equal(switchFor(view,'锁定布局').getAttribute('aria-checked'),'true');assert.equal(switchFor(view,'锁定布局').getAttribute('aria-disabled'),null);assert.equal(view.container.querySelector('[role=alert]'),null);assert.deepEqual(calls,['get','get','get']);await view.unmount();
});
test('mode failures preserve values and repeated opens share the pending operation guard',async()=>{
  h.environment();let fail=true;const waiting=gate(),calls=[];
  window.__TAURI__.core.invoke=async(command,args)=>{calls.push(args.action);if(args.action==='get')return {layout:{viewOnly:false,layoutLocked:false}};if(args.action==='open')return waiting.promise;if(fail)throw Error('临时模式失败');return {};};
  const view=await h.mount(CanvasSettings,{});await h.click(switchFor(view,'仅查看桌面组件'));assert.equal(switchFor(view,'仅查看桌面组件').getAttribute('aria-checked'),'false');assert.match(view.container.querySelector('[role=alert]').textContent,/临时模式失败/);
  fail=false;await h.click(switchFor(view,'仅查看桌面组件'));assert.equal(switchFor(view,'仅查看桌面组件').getAttribute('aria-checked'),'true');
  await h.click(h.button(view.container,'打开桌面组件'));await h.click(h.button(view.container,'打开桌面组件'));await h.click(switchFor(view,'锁定布局'));assert.equal(calls.filter(action=>action==='open').length,1);assert.equal(calls.includes('setLayoutLocked'),false);
  await h.act(async()=>waiting.resolve({}));assert.equal(h.button(view.container,'打开桌面组件').disabled,false);await view.unmount();
});
test('unmounted mode operations cannot dispatch synthetic state into another page',async()=>{
  h.environment();const waiting=gate();let updates=0;const listen=()=>updates++;window.addEventListener('flowhub:canvas-view-only',listen);
  window.__TAURI__.core.invoke=async(command,args)=>args.action==='get'?{layout:{viewOnly:false}}:waiting.promise;
  const view=await h.mount(CanvasSettings,{});await h.click(switchFor(view,'仅查看桌面组件'));await view.unmount();await h.act(async()=>waiting.resolve({}));assert.equal(updates,0);window.removeEventListener('flowhub:canvas-view-only',listen);
});
test('read-only and unavailable native bridges never expose a retry or a write path',async()=>{
  for(const preview of [true,false]){h.environment({},preview);if(!preview)window.__TAURI__={};const view=await h.mount(CanvasSettings,{});
    assert.equal(h.button(view.container,'打开桌面组件').disabled,true);assert.equal(switchFor(view,'锁定布局').getAttribute('aria-disabled'),'true');assert.equal(view.container.querySelector('[aria-label="重新读取组件设置"]'),null);assert.equal(view.container.querySelector('[role=status]'),null);await view.unmount();}
});
