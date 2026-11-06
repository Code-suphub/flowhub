const {test}=require('node:test'),assert=require('node:assert/strict');
const h=require('./settings-harness.test.cjs'),{Settings}=require('../../src/settings/index.tsx');
const footer=()=>document.querySelector('footer[aria-label="配置保存与状态"]');
function platform(t,value){const previous=Object.getOwnPropertyDescriptor(window.navigator,'platform');Object.defineProperty(window.navigator,'platform',{value,configurable:true});t.after(()=>{if(previous)Object.defineProperty(window.navigator,'platform',previous);else delete window.navigator.platform;});}
async function press(target,extra={}){let event;await h.act(async()=>{event=new window.KeyboardEvent('keydown',{key:'s',code:'KeyS',bubbles:true,cancelable:true,...extra});target.dispatchEvent(event);});return event;}

test('save status survives operation notices and failed shortcuts retain drafts until one retry completes',async t=>{
  platform(t,'MacIntel');let fail=true,calls=0,release;const pending=new Promise(resolve=>release=resolve);
  const {store}=await h.loaded({saveConfig:async config=>{calls++;if(fail)throw Error('临时保存失败');await pending;return {ok:true,config};}}),view=await h.mount(Settings,{store});
  await h.click(view.container.querySelector('[aria-label="开机自动启动"]'));await h.act(async()=>store.notice('测试通知已发送'));
  assert.match(footer().querySelector('.settings-save-status').textContent,/有未保存修改/);assert.match(footer().textContent,/测试通知已发送/);
  await press(document.body,{metaKey:true});assert.equal(calls,1);assert.equal(store.dirty,true);assert.match(footer().querySelector('[role=alert]').textContent,/临时保存失败/);
  fail=false;await press(document.body,{metaKey:true});assert.equal(footer().dataset.saveState,'busy');await press(document.body,{metaKey:true,repeat:true});await press(document.body,{metaKey:true});await h.click(h.button(footer(),'处理中…'));assert.equal(calls,2);
  await h.act(async()=>release());assert.equal(store.dirty,false);assert.equal(footer().dataset.saveState,'saved');assert.equal(footer().querySelector('[role=alert]'),null);
  await press(document.body,{metaKey:true});assert.equal(calls,2);await view.unmount();store.dispose();
});
test('save shortcut respects composition, extra modifiers, dialogs and shortcut recording',async t=>{
  platform(t,'MacIntel');const {store,writes}=await h.loaded(),view=await h.mount(Settings,{store});await h.click(view.container.querySelector('[aria-label="开机自动启动"]'));
  await press(document.body,{metaKey:true,isComposing:true});await press(document.body,{metaKey:true,shiftKey:true});assert.equal(writes.length,0);
  await h.click(view.container.querySelector('[aria-label="查看未保存修改"]'));await press(document.querySelector('[role=dialog] button'),{metaKey:true});assert.equal(writes.length,0);await h.click(h.button(document.querySelector('[role=dialog]'),'继续编辑'));
  const recorder=view.container.querySelector('[aria-label="唤出 FlowHub"]');await h.click(recorder);await press(recorder,{metaKey:true});assert.equal(writes.length,0);assert.equal(store.snapshot().config.core.hotkey,'Command+S');
  await view.unmount();await press(document.body,{metaKey:true});assert.equal(writes.length,0);store.dispose();
});
test('non-Mac uses Control+S, while preview and clean configurations cannot write',async t=>{
  platform(t,'Win32');const {store,writes}=await h.loaded(),view=await h.mount(Settings,{store});await h.click(view.container.querySelector('[aria-label="开机自动启动"]'));
  await press(document.body,{metaKey:true});assert.equal(writes.length,0);await press(document.body,{ctrlKey:true});assert.equal(writes.length,1);assert.equal(footer().querySelector('[aria-keyshortcuts]').getAttribute('aria-keyshortcuts'),'Control+S');await view.unmount();store.dispose();
  const preview=await h.loaded({},true),readonlyView=await h.mount(Settings,{store:preview.store});await press(document.body,{ctrlKey:true});assert.equal(preview.writes.length,0);assert.equal(footer().dataset.saveState,'preview');await readonlyView.unmount();preview.store.dispose();
});
