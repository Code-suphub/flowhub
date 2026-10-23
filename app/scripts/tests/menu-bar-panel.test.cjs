const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const {buildSync}=require('esbuild');
const app=path.resolve(__dirname,'../..');
const bundle=buildSync({stdin:{contents:`import {createElement} from 'react';
  import {createRoot} from 'react-dom/client';
  import {MenuBarPanel} from './src/surfaces/MenuBarPanel';
  export function mount(node){const root=createRoot(node);root.render(createElement(MenuBarPanel));return ()=>root.unmount();}`,
  resolveDir:app,loader:'tsx'},bundle:true,write:false,format:'iife',globalName:'MenuBarTest',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(predicate){for(let i=0;i<200;i++){if(predicate())return;await delay(5);}assert.ok(predicate(),'menu-bar panel did not settle');}
const item=(windowId,section='visible',extra={})=>({windowId,displayName:`图标 ${windowId}`,section,hideable:true,...extra});
const snapshot=items=>({ok:true,trusted:true,organizerEnabled:true,items});
async function setup(t,invoke){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/menu-bar-panel.html',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,calls=[],events=new Map(),errors=[];
  w.addEventListener('error',event=>errors.push(event.error));
  if(invoke)w.__TAURI__={core:{invoke:async(command,args)=>{calls.push({command,args});return invoke(command,args);}},event:{listen:async(name,handler)=>{events.set(name,handler);return ()=>events.delete(name);}}};
  w.eval(bundle);const dispose=w.MenuBarTest.mount(w.document.getElementById('root'));
  let disposed=false;const unmount=()=>{if(!disposed){disposed=true;dispose();}};
  t.after(()=>{unmount();dom.window.close();assert.deepEqual(errors,[]);});
  await wait(()=>w.document.querySelector('main'));
  const rows=()=>[...w.document.querySelectorAll('.fh-row')];
  const names=()=>rows().map(row=>row.querySelector('strong').textContent);
  const controls=()=>[...w.document.querySelectorAll('[role="switch"]')];
  const disabled=node=>node.getAttribute('aria-disabled')==='true';
  const refresh=()=>[...w.document.querySelectorAll('button')].find(button=>button.textContent==='刷新顺序');
  const notice=()=>w.document.querySelector('[role="status"]').textContent;
  return {w,calls,events,unmount,rows,names,controls,disabled,refresh,notice};
}

test('sections stay distinct from fixed capabilities; unknown sections cannot be toggled',async t=>{
  const s=await setup(t,async()=>snapshot([item(1),item(2,'hidden'),item(3,'alwaysHidden'),item(4,'future'),item(5,'visible',{hideable:false})]));
  await wait(()=>s.rows().length===5);
  assert.deepEqual(s.rows().map(row=>row.querySelector('small').textContent),['常显区','随箭头展开／收起','始终隐藏区','分区未知','常显区 · 系统固定']);
  assert.deepEqual(s.controls().map(s.disabled),[false,false,false,true,true]);
  s.controls()[3].click();s.controls()[4].click();await delay(10);
  assert.equal(s.calls.filter(call=>call.command==='set_menu_bar_item_hidden').length,0);
  assert.match(s.w.document.querySelector('footer').textContent,/5 个图标 · 1 个隐藏/);
});

test('actual hide/show IPC remains available, deduplicated, and restores an arrow-hidden section',async t=>{
  let section='visible';
  const s=await setup(t,async(command,args)=>{
    if(command==='set_menu_bar_item_hidden'){section=args.hidden?'alwaysHidden':'hidden';return {ok:true};}
    return snapshot([item(1,section)]);
  });
  await wait(()=>s.controls().length===1&&!s.disabled(s.controls()[0]));
  const control=s.controls()[0];control.click();control.click();
  await wait(()=>control.getAttribute('aria-checked')==='false'&&!s.disabled(control));
  assert.equal(s.calls.filter(call=>call.command==='set_menu_bar_item_hidden').length,1);
  control.click();await wait(()=>control.getAttribute('aria-checked')==='true'&&!s.disabled(control));
  assert.equal(s.rows()[0].querySelector('small').textContent,'随箭头展开／收起');
  assert.deepEqual(s.calls.filter(call=>call.command==='set_menu_bar_item_hidden').map(call=>({...call.args})),[{windowId:1,hidden:true},{windowId:1,hidden:false}]);
});

test('mutation refresh preserves row order, focus and scroll; reopening follows inventory order',async t=>{
  let data=snapshot([item(1),item(2,'alwaysHidden'),item(3,'hidden')]);
  const s=await setup(t,async(command,args)=>{
    if(command==='set_menu_bar_item_hidden'){data=snapshot([item(3,'hidden'),item(2,'alwaysHidden'),item(1,'alwaysHidden'),item(4)]);return {ok:true};}
    return data;
  });
  await wait(()=>s.rows().length===3);
  const main=s.w.document.querySelector('main'),control=s.controls()[0];
  main.scrollTop=80;control.focus();control.click();
  await wait(()=>s.rows().length===4&&!s.disabled(control));
  assert.deepEqual(s.names(),['图标 1','图标 2','图标 3','图标 4']);
  assert.equal(main.scrollTop,80);assert.equal(s.w.document.activeElement,control);
  s.events.get('menu-bar-panel-opened')();await wait(()=>s.names()[0]==='图标 3');
  assert.deepEqual(s.names(),['图标 3','图标 2','图标 1','图标 4']);assert.equal(main.scrollTop,80);
  data=snapshot([item(4),item(5)]);s.refresh().click();await wait(()=>s.rows().length===2);
  assert.deepEqual(s.names(),['图标 4','图标 5']);
});

test('failed scans preserve the inventory but block stale actions until a successful retry',async t=>{
  let data=snapshot([item(1)]),failure=null;
  const s=await setup(t,async()=>{if(failure)throw failure;return data;});
  await wait(()=>s.controls().length===1&&!s.disabled(s.controls()[0]));
  for(const [response,error,message] of [[{ok:false,reason:'扫描失败'},null,'扫描失败'],[data,Error('IPC disconnected'),'IPC disconnected'],[{ok:false},null,'读取失败']]){
    data=response;failure=error;s.refresh().click();await wait(()=>s.notice().includes(message));
    assert.deepEqual(s.names(),['图标 1']);assert.equal(s.disabled(s.controls()[0]),true);assert.equal(s.refresh().disabled,false);
    s.controls()[0].click();
  }
  assert.equal(s.calls.filter(call=>call.command==='set_menu_bar_item_hidden').length,0);
  failure=null;data=snapshot([item(1)]);s.refresh().click();await wait(()=>!s.disabled(s.controls()[0]));
});

test('refreshes coalesce and pending results cannot update an unmounted panel',async t=>{
  let finish;const pending=new Promise(resolve=>finish=resolve);
  const s=await setup(t,async()=>pending);
  await wait(()=>s.events.has('menu-bar-panel-opened'));
  s.events.get('menu-bar-panel-opened')();s.events.get('menu-bar-panel-opened')();
  assert.equal(s.calls.length,1);assert.equal(s.refresh().disabled,true);
  s.unmount();finish(snapshot([item(1)]));await delay(20);
  assert.equal(s.w.document.getElementById('root').textContent,'');assert.equal(s.events.size,0);
  s.w.document.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(s.calls.length,1);
});

test('backend refusals and unconfirmed or unknown placement never report a successful move',async t=>{
  let data=snapshot([item(1,'alwaysHidden')]),result={ok:false,reason:'鼠标正在使用中'};
  const s=await setup(t,async command=>command==='set_menu_bar_item_hidden'?result:data);
  await wait(()=>s.controls().length===1&&!s.disabled(s.controls()[0]));
  s.controls()[0].click();await wait(()=>s.notice().includes('鼠标正在使用中'));
  assert.equal(s.controls()[0].getAttribute('aria-checked'),'false');
  result={ok:true};s.controls()[0].click();await wait(()=>s.notice().includes('图标位置尚未更新'));
  data=snapshot([item(1,'future')]);s.controls()[0].click();await wait(()=>s.rows()[0].querySelector('small').textContent==='分区未知');
  await wait(()=>s.notice().includes('图标位置尚未更新'));
  assert.equal(s.disabled(s.controls()[0]),true);
});

test('permission, disabled organizer, empty inventory, preview and close keep their IPC boundaries',async t=>{
  let data={...snapshot([item(1)]),trusted:false};
  const s=await setup(t,async command=>command==='toggle_menu_bar_panel'?null:data);
  await wait(()=>s.notice().includes('需要辅助功能权限'));assert.equal(s.disabled(s.controls()[0]),true);
  data={...snapshot([item(1)]),organizerEnabled:false};s.refresh().click();await wait(()=>s.notice().includes('请先启用隐藏分区'));
  assert.equal(s.disabled(s.controls()[0]),true);
  data=snapshot([]);s.refresh().click();await wait(()=>s.notice().includes('没有发现菜单栏图标'));
  s.w.document.querySelector('[aria-label="关闭面板"]').click();
  s.w.document.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  s.w.document.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  assert.equal(s.calls.filter(call=>call.command==='toggle_menu_bar_panel').length,2);
  assert.ok(s.calls.every(call=>['list_menu_bar_items','toggle_menu_bar_panel'].includes(call.command)));
  const preview=await setup(t);await wait(()=>preview.notice().includes('浏览器预览只读'));
  assert.equal(preview.refresh().disabled,true);assert.equal(preview.w.document.querySelector('[aria-label="关闭面板"]').disabled,true);
  assert.equal(preview.calls.length,0);
});
