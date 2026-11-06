const {test}=require('node:test'),assert=require('node:assert/strict');
const h=require('./settings-harness.test.cjs'),{Settings}=require('../../src/settings/index.tsx');
const flush=()=>h.act(async()=>new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve))));
const go=(view,page)=>h.click(view.container.querySelector(`[data-page="${page}"]`));
const advanced=view=>view.container.querySelector('.settings-collection-advanced');

test('menu filter, temporary preview and options expansion survive navigation without saving',async()=>{
  const {store,writes}=await h.loaded({},true),before=JSON.stringify(store.snapshot().config),view=await h.mount(Settings,{store});await go(view,'menubar');
  await h.click(h.button(view.container,'已显示'));await h.click(view.container.querySelector('[role=switch][aria-label="显示 FlowHub"]'));await h.click(view.container.querySelector('.settings-menu-options summary'));await flush();
  assert.equal(view.container.querySelector('.settings-menu-options').open,true);assert.equal(view.container.querySelectorAll('.settings-menu-item').length,2);
  await go(view,'core');await go(view,'menubar');assert.equal(view.container.querySelector('[role=tab][aria-selected=true]').textContent,'已显示');assert.equal(view.container.querySelector('.settings-menu-options').open,true);assert.equal(view.container.querySelectorAll('.settings-menu-item').length,2);assert.equal(JSON.stringify(store.snapshot().config),before);assert.equal(writes.length,0);
  await view.unmount();store.dispose();
});
test('advanced sections belong to each web or memo entry and restore after page changes',async()=>{
  const {store,writes}=await h.loaded({},true),view=await h.mount(Settings,{store});
  for(const [page,attribute,first,second] of [['web','data-node-id','p','b'],['memo','data-memo-key','m1','m2']]){
    await go(view,page);await h.click(view.container.querySelector(`[${attribute}="${first}"]`));await h.click(advanced(view).querySelector('summary'));await flush();assert.equal(advanced(view).open,true,page);
    await h.click(view.container.querySelector(`[${attribute}="${second}"]`));assert.equal(advanced(view).open,false,page+' leaked expansion');await h.click(view.container.querySelector(`[${attribute}="${first}"]`));await flush();assert.equal(advanced(view).open,true,page+' forgot expansion');
    await go(view,'core');await go(view,page);await flush();assert.equal(advanced(view).open,true,page+' lost state on navigation');
  }
  assert.equal(writes.length,0);await view.unmount();store.dispose();
});
test('source changes and new settings windows discard previous presentation state',async()=>{
  const {store}=await h.loaded({},true);let view=await h.mount(Settings,{store});await go(view,'menubar');await h.click(h.button(view.container,'已显示'));await h.click(view.container.querySelector('.settings-menu-options summary'));await flush();
  await h.act(async()=>store.patch({configPath:{resolvedPath:'/fixture/new-source'}}));await flush();assert.equal(view.container.querySelector('[role=tab][aria-selected=true]').textContent,'全部项目');assert.equal(view.container.querySelector('.settings-menu-options').open,false);
  await h.click(view.container.querySelector('.settings-menu-options summary'));await flush();await view.unmount();view=await h.mount(Settings,{store});await go(view,'menubar');assert.equal(view.container.querySelector('.settings-menu-options').open,false);await view.unmount();store.dispose();
});
test('search-driven expansion is remembered without invoking the permission action',async()=>{
  let permissions=0;const {store,writes}=await h.loaded({requestMenuBarManagementPermission:async()=>permissions++},true),view=await h.mount(Settings,{store});
  await h.click(view.container.querySelector('[aria-label="搜索设置"]'));await h.input(document.querySelector('[aria-label="搜索设置项"]'),'菜单栏权限');await h.click(document.querySelector('[data-command-id="menubar-permission"]'));await flush();await flush();
  assert.equal(view.container.querySelector('.settings-menu-options').open,true);await go(view,'core');await go(view,'menubar');assert.equal(view.container.querySelector('.settings-menu-options').open,true);assert.equal(permissions,0);assert.equal(writes.length,0);await view.unmount();store.dispose();
});
test('export scope persists but a removed plugin scope safely resolves to all configuration',async()=>{
  const {store,writes}=await h.loaded(),view=await h.mount(Settings,{store});await h.act(async()=>store.edit(config=>{config.plugins.custom={settings:{}};}));await go(view,'data');
  await h.click(view.container.querySelector('[aria-label="导出范围"]'));await h.click([...document.querySelectorAll('[role=option]')].find(option=>option.textContent==='custom'));await go(view,'core');await go(view,'data');assert.equal(view.container.querySelector('[aria-label="导出范围"] [data-slot=select-value]').textContent,'custom');
  await h.act(async()=>store.edit(config=>{delete config.plugins.custom;}));assert.equal(view.container.querySelector('[aria-label="导出范围"] [data-slot=select-value]').textContent,'全部配置');assert.equal(writes.length,0);assert.equal(document.querySelector('[role=dialog]'),null);await view.unmount();store.dispose();
});
