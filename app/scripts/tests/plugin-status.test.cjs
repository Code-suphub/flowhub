const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const bundle=fs.readFileSync(require('node:path').join(__dirname,'../../ui/react/host.js'),'utf8');
const settle=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.ok(predicate(),'React state did not settle');};
function setup(invoke,root='plugin-status-root'){
  const dom=new JSDOM(`<div id="${root}"></div>`,{url:'http://localhost/?id=machines',runScripts:'outside-only',pretendToBeVisual:true});
  if(invoke)dom.window.__TAURI__={core:{invoke}};
  dom.window.eval(bundle);
  return {dom,w:dom.window,button:label=>[...dom.window.document.querySelectorAll('button')].find(x=>x.textContent===label)};
}
test('React status saves zero or multiple favorites and does not submit twice',async t=>{
  for(const favorites of [[],['a','b']]){
    const calls=[];let finish;
    const data={preferences:{tray:true,pinned:true,favorites:[]},snapshot:{rows:[{id:'a',name:'A',status:'healthy'},{id:'b',name:'B',status:'unknown'}]}};
    const {dom,w,button}=setup(async(command,args)=>{calls.push(args);if(args.action==='save')return new Promise(resolve=>{finish=()=>resolve({...data,preferences:args.payload});});return data;});t.after(()=>dom.window.close());
    await settle(()=>w.document.querySelectorAll('.fh-status-favorites [role=checkbox]').length===2);
    assert.equal(w.document.querySelector('label[for="favorite-a"]')?.textContent,'A');
    await settle(()=>w.document.body.textContent.includes('后台采集未开启') && w.document.querySelector('[aria-label="窗口始终置顶"]')?.getAttribute('aria-checked')==='true');
    for(const [index,id] of ['a','b'].entries())if(favorites.includes(id)){
      w.document.querySelectorAll('.fh-status-favorites [role=checkbox]')[index].click();
      await settle(()=>w.document.querySelectorAll('.fh-status-favorites [role=checkbox]')[index].getAttribute('aria-checked')==='true');
    }
    button('保存设置').click();button('保存设置')?.click();await settle(()=>finish);
    const saved=calls.filter(c=>c.action==='save');assert.equal(saved.length,1);assert.deepEqual(Array.from(saved[0].payload.favorites),favorites);assert.equal(saved[0].payload.pinned,true);
    finish();await settle(()=>w.document.body.textContent.includes('显示设置已保存') && !button('保存设置').disabled);
  }
});
test('status preview is readonly; backend failures remain visible',async t=>{
  const preview=setup();t.after(()=>preview.dom.window.close());await settle(()=>preview.button('打开插件 ↗'));
  assert.equal(preview.button('打开插件 ↗').disabled,true);assert.equal(preview.w.document.querySelector('details'),null);
  const failure=setup(async()=>{throw Error('读取失败');});t.after(()=>failure.dom.window.close());await settle(()=>failure.w.document.body.textContent.includes('读取失败'));
});
test('menu-bar actions are locked until native state is available and rechecked after changing',async t=>{
  let hidden=false;const calls=[];
  const {dom,w}=setup(async(command,args)=>{calls.push(command);if(command==='set_menu_bar_item_hidden'){hidden=args.hidden;return {ok:true};}return {ok:true,trusted:true,organizerEnabled:true,items:[{windowId:1,displayName:'测试图标',hideable:true,section:hidden?'alwaysHidden':'visible'}]};},'menu-bar-root');t.after(()=>dom.window.close());
  await settle(()=>w.document.querySelector('[role=switch]')&&!w.document.querySelector('[role=switch]').disabled);
  const control=w.document.querySelector('[role=switch]');control.click();control.click();
  await settle(()=>control.getAttribute('aria-checked')==='false'&&!control.disabled);
  assert.equal(calls.filter(c=>c==='set_menu_bar_item_hidden').length,1);assert.equal(calls.filter(c=>c==='list_menu_bar_items').length,2);
});
test('detail surface binds native RPC to the host-provided plugin and preserves sandbox',async t=>{
  const calls=[],dom=new JSDOM('<div id="plugin-detail-root"></div>',{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
  let mount;
  dom.window.FlowHubWidgetFrame={mount:(frame,options)=>{mount={frame,options};return {dispose(){}};}};
  dom.window.__TAURI__={core:{invoke:async(command,args)=>{calls.push({command,args});if(command==='plugin_canvas_api')return {plugin:'bound-plugin',url:'flowhub-plugin://bound-plugin/detail.html',context:{title:'详情'}};return {ok:true};}}};
  dom.window.eval(bundle);await settle(()=>mount);
  assert.equal(mount.frame.getAttribute('sandbox'),'allow-scripts');assert.equal(mount.options.context.title,'详情');
  await mount.options.rpc({action:'get',id:'foreign-plugin'});
  assert.equal(calls[1].command,'plugin_widget_rpc');assert.equal(calls[1].args.id,'bound-plugin');
});
test('status poll started before save cannot replace saved preferences with stale data',async t=>{
  let reads=0,finishPoll;
  const original={preferences:{tray:false,pinned:false,favorites:[]},snapshot:{rows:[]}};
  const {dom,w,button}=setup(async(command,args)=>{
    if(args.action==='get'){reads++;if(reads===1)return original;return new Promise(resolve=>{finishPoll=()=>resolve(original);});}
    if(args.action==='save')return {...original,preferences:args.payload};
  });t.after(()=>dom.window.close());
  await settle(()=>w.document.body.textContent.includes('后台采集未开启，显示已有缓存'));
  w.document.dispatchEvent(new w.Event('visibilitychange'));await settle(()=>finishPoll);
  w.document.querySelector('[aria-label="窗口始终置顶"]').click();
  await settle(()=>w.document.querySelector('[aria-label="窗口始终置顶"]').getAttribute('aria-checked')==='true');button('保存设置').click();
  await settle(()=>w.document.body.textContent.includes('显示设置已保存'));finishPoll();await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(w.document.querySelector('[aria-label="窗口始终置顶"]').getAttribute('aria-checked'),'true');
});
