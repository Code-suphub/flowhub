const {test}=require('node:test'),assert=require('node:assert/strict');
const h=require('./settings-harness.test.cjs');
const {Settings}=require('../../src/settings/index.tsx');
const {SettingsSearch}=require('../../src/settings/SettingsSearch.tsx');
const {settingsSearchEntries,findSettings}=require('../../src/settings/settings-search.ts');
const {locateSetting}=require('../../src/settings/useSettingLocation.ts');
const dialog=()=>document.querySelector('[role=dialog]');
const search=()=>document.querySelector('input[aria-label="搜索设置项"]');
const flush=()=>h.act(async()=>new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve))));
async function press(element,key,extra={}){let event;await h.act(async()=>{element.focus();event=new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});element.dispatchEvent(event);});return event;}
function layout(t){const previous=window.HTMLElement.prototype.getClientRects;window.HTMLElement.prototype.getClientRects=function(){return [{top:0,left:0,right:240,bottom:32,width:240,height:32}];};t.after(()=>{window.HTMLElement.prototype.getClientRects=previous;});}
function platform(t,value){const previous=Object.getOwnPropertyDescriptor(window.navigator,'platform');Object.defineProperty(window.navigator,'platform',{value,configurable:true});t.after(()=>{if(previous)Object.defineProperty(window.navigator,'platform',previous);else delete window.navigator.platform;});}
async function choose(view,query,id){await h.click(view.container.querySelector('[aria-label="搜索设置"]'));await h.input(search(),query);await flush();await h.click(document.querySelector(`[data-command-id="${id}"]`));await flush();await flush();}

test('host settings index supports Chinese aliases, English terms, exact ranking and bounded results',()=>{
  assert.equal(new Set(settingsSearchEntries.map(item=>item.id)).size,settingsSearchEntries.length);
  for(const [query,id] of [['开机启动','launch-at-login'],['保留天数','clipboard-retention'],['菜单栏权限','menubar-permission'],['max records','clipboard-records'],['主题','theme'],['应用范围键','scope-key:app']])assert.equal(findSettings(query)[0].id,id,query);
  assert.equal(findSettings('ＭＡＸ records')[0].id,'clipboard-records');assert.deepEqual(findSettings('不存在的随机字段'),[]);assert.ok(findSettings('').some(item=>item.id==='page:extensions'));assert.ok(findSettings('设置').length<=60);
});
test('every indexed target resolves on its host page, including collapsed menu options',async()=>{
  const {store}=await h.loaded({listConfigHistory:async()=>({entries:[{id:'one',created_at:1}]})}),view=await h.mount(Settings,{store});
  for(const page of new Set(settingsSearchEntries.filter(item=>item.target).map(item=>item.page))){
    await h.click(view.container.querySelector(`[data-page="${page}"]`));
    for(const item of settingsSearchEntries.filter(item=>item.page===page&&item.target))assert.ok(locateSetting(view.container.querySelector('main'),item.target),item.id+' has no target');
  }
  await view.unmount();store.dispose();
});
test('search typing and clearing never call native APIs or edit configuration',async()=>{
  const {store,writes}=await h.loaded(),view=await h.mount(Settings,{store}),before=JSON.stringify(store.snapshot().config);let calls=0;
  for(const [name,fn] of Object.entries(window.weborg))if(typeof fn==='function')window.weborg[name]=(...args)=>{calls++;return fn(...args);};
  await h.click(view.container.querySelector('[aria-label="搜索设置"]'));await flush();assert.equal(document.activeElement===search(),true);
  for(const query of ['留存天数','主题','clear history','没有这样的字段'])await h.input(search(),query);
  assert.match(dialog().textContent,/没有匹配的设置/);await h.click(dialog().querySelector('[aria-label="清除设置搜索"]'));assert.equal(search().value,'');assert.match(dialog().textContent,/常用设置与页面/);assert.equal(calls,0);assert.equal(writes.length,0);assert.equal(JSON.stringify(store.snapshot().config),before);
  await press(search(),'Escape');await flush();assert.equal(dialog(),null);assert.equal(document.activeElement===view.container.querySelector('[aria-label="搜索设置"]'),true);await view.unmount();store.dispose();
});
test('keyboard Enter locates an editable control and does not activate it or save the draft',async t=>{
  layout(t);const {store,writes}=await h.loaded(),view=await h.mount(Settings,{store});await h.click(view.container.querySelector('[aria-label="搜索设置"]'));await h.input(search(),'留存天数');await flush();
  await press(search(),'Enter');await flush();await flush();assert.equal(dialog(),null);assert.equal(view.container.querySelector('h1').textContent,'剪贴板');
  const input=view.container.querySelector('[aria-label="留存天数"]');assert.equal(document.activeElement===input,true);assert.equal(input.closest('[data-setting-label]').dataset.settingHighlight,'true');assert.equal(store.dirty,false);assert.equal(writes.length,0);
  await h.input(input,'21');assert.equal(store.snapshot().config.plugins.clipboard.settings.retentionDays,21);assert.equal(document.activeElement===input,true);assert.equal(writes.length,0);await view.unmount();store.dispose();
});
test('locating collapsed permission controls opens their section without requesting permission',async t=>{
  layout(t);let permissions=0;const {store}=await h.loaded({requestMenuBarManagementPermission:async()=>{permissions++;return {};}}),view=await h.mount(Settings,{store});await choose(view,'菜单栏权限','menubar-permission');
  const details=view.container.querySelector('.settings-menu-options');assert.equal(details.open,true);assert.equal(document.activeElement===h.button(details,'授权辅助功能'),true);assert.equal(permissions,0);assert.equal(store.dirty,false);await view.unmount();store.dispose();
});
test('locating a distant setting scrolls its content pane without shifting the outer document',async t=>{
  layout(t);const {store}=await h.loaded(),view=await h.mount(Settings,{store});
  await h.click(view.container.querySelector('[data-page="tools"]'));
  const main=view.container.querySelector('main'),control=view.container.querySelector('[aria-label="计算表达式"]');
  main.style.overflowY='auto';
  Object.defineProperties(main,{clientHeight:{value:160},scrollHeight:{value:1000}});
  main.getBoundingClientRect=()=>({top:100,bottom:260,height:160});
  control.getBoundingClientRect=()=>({top:580-main.scrollTop,bottom:616-main.scrollTop,height:36});
  const root=document.documentElement;root.scrollTop=0;t.after(()=>{root.scrollTop=0;});
  // WebKit can scroll an overflow-hidden outer ancestor as well as main.
  control.scrollIntoView=()=>{root.scrollTop=18;};
  await choose(view,'计算表达式','tool:calculator');
  assert.equal(document.activeElement,control);assert.equal(main.scrollTop,418);assert.equal(root.scrollTop,0);assert.equal(store.dirty,false);
  await view.unmount();store.dispose();
});
test('destructive and file-picker entries only locate buttons; confirmation still needs a separate action',async t=>{
  layout(t);let clears=0,picks=0;const {store,writes}=await h.loaded({pickConfigImport:async()=>{picks++;return {canceled:true};}}),view=await h.mount(Settings,{store});window.FlowHubCommandStore={counts:()=>({total:3,templates:1}),clearAll:()=>clears++};
  await choose(view,'清空历史','clear-command-history');assert.equal(document.activeElement===h.button(view.container,'清空历史与模板'),true);assert.equal(dialog(),null);assert.equal(clears,0);
  await choose(view,'导入配置','config-import');assert.equal(document.activeElement===h.button(view.container,'导入配置…'),true);assert.equal(dialog(),null);assert.equal(picks,0);assert.equal(writes.length,0);await view.unmount();store.dispose();delete window.FlowHubCommandStore;
});
test('readonly settings locate their disabled row without exposing writes',async t=>{
  layout(t);const {store,writes}=await h.loaded({},true),view=await h.mount(Settings,{store});await choose(view,'留存天数','clipboard-retention');const row=view.container.querySelector('[data-setting-label="留存天数"]');
  assert.equal(document.activeElement===row,true);assert.equal(row.querySelector('input').matches(':disabled'),true);assert.equal(store.dirty,false);assert.equal(writes.length,0);await view.unmount();store.dispose();
});
test('the platform shortcut opens search, respects IME and does not replace shortcut recording',async t=>{
  platform(t,'MacIntel');const {store}=await h.loaded(),view=await h.mount(Settings,{store});
  const ordinary=await press(document.body,'k',{ctrlKey:true});assert.equal(dialog(),null);assert.equal(ordinary.defaultPrevented,false);
  await press(document.body,'k',{metaKey:true,isComposing:true});assert.equal(dialog(),null);
  await press(document.body,'k',{metaKey:true});await flush();assert.ok(search());await press(search(),'Escape');await flush();
  await h.click(view.container.querySelector('[aria-label="唤出 FlowHub"]'));await press(view.container.querySelector('[aria-label="唤出 FlowHub"]'),'k',{metaKey:true,code:'KeyK'});assert.equal(dialog(),null);assert.match(store.snapshot().config.core.hotkey,/Command\+K/);
  await view.unmount();store.dispose();
});
test('composition Enter does not select a setting, and a failed navigation keeps search open',async()=>{
  h.environment();let selections=0;const view=await h.mount(SettingsSearch,{onClose:()=>{},onChoose:()=>{selections++;return {ok:false,error:'请先完成配置 JSON'};}});await h.input(search(),'留存天数');await flush();
  await press(search(),'Enter',{isComposing:true,keyCode:229});assert.equal(selections,0);await press(search(),'Enter');assert.equal(selections,1);assert.match(dialog().querySelector('[role=alert]').textContent,/完成配置 JSON/);assert.equal(search().value,'留存天数');await view.unmount();
});
test('another dialog blocks the search shortcut, and dirty state survives locating another page',async t=>{
  platform(t,'MacIntel');layout(t);const {store,writes}=await h.loaded(),view=await h.mount(Settings,{store});await h.click(view.container.querySelector('[aria-label="开机自动启动"]'));await h.click(view.container.querySelector('[aria-label="查看未保存修改"]'));
  await press(document.body,'k',{metaKey:true});assert.equal(document.querySelector('[aria-label="搜索设置项"]'),null);assert.equal(document.querySelectorAll('[role=dialog]').length,1);await h.click(h.button(dialog(),'继续编辑'));await flush();
  await choose(view,'主题','theme');assert.equal(view.container.querySelector('h1').textContent,'外观');assert.equal(store.dirty,true);assert.equal(store.snapshot().config.core.launchAtLogin,true);assert.equal(writes.length,0);await view.unmount();store.dispose();
});
test('ordinary input after a location request cancels queued focus transfer',async t=>{
  layout(t);const {store}=await h.loaded(),view=await h.mount(Settings,{store});await h.click(view.container.querySelector('[aria-label="搜索设置"]'));await h.input(search(),'开机启动');await h.click(document.querySelector('[data-command-id="launch-at-login"]'));
  const lookup=view.container.querySelector('[aria-label="查找页面"]');await press(lookup,'ArrowLeft');await flush();await flush();assert.equal(document.activeElement===lookup,true);await view.unmount();store.dispose();
});
test('non-Mac browsers use Control+K without accepting an extra modifier',async t=>{
  platform(t,'Win32');const {store}=await h.loaded(),view=await h.mount(Settings,{store});await press(document.body,'k',{ctrlKey:true,altKey:true});assert.equal(dialog(),null);
  await press(document.body,'k',{ctrlKey:true});await flush();assert.ok(search());await press(search(),'Escape');await flush();assert.equal(dialog(),null);await view.unmount();store.dispose();
});
test('an unmounted or hidden select list does not block opening search',async()=>{
  const {store}=await h.loaded(),view=await h.mount(Settings,{store}),list=document.createElement('div');list.setAttribute('role','listbox');list.style.display='none';document.body.append(list);
  await h.click(view.container.querySelector('[aria-label="搜索设置"]'));assert.ok(search());await press(search(),'Escape');await flush();list.remove();await view.unmount();store.dispose();
});
