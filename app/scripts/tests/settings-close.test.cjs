const {test}=require('node:test'),assert=require('node:assert/strict');
const h=require('./settings-harness.test.cjs');
const {bindSettingsClose}=require('../../src/settings/close.ts');
const {Settings}=require('../../src/settings/index.tsx');
test('native close checks current draft, queues through loading, and disposes its entry point',async()=>{
 let resolveConfig,closed=0,prompted=0;
 h.environment({getConfig:()=>new Promise(resolve=>resolveConfig=resolve),closeSettings:async()=>{closed++;}});
 const store=new h.SettingsStore(),dispose=bindSettingsClose(store,()=>prompted++),load=store.load();
 window.requestSettingsClose();window.requestSettingsClose();assert.equal(closed,0);
 resolveConfig(h.fixture());await load;await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
 store.edit(c=>{c.core.launchAtLogin=true;});window.requestSettingsClose();assert.equal(prompted,1);assert.equal(closed,1);assert.ok(localStorage.length);
 dispose();assert.equal(window.requestSettingsClose,undefined);store.dispose();
});
test('title-bar close supports cancel, failed save, retained raw JSON draft, and successful save',async()=>{
 let closed=0,fail=true;
 const {store}=await h.loaded({closeSettings:async()=>{closed++;},saveConfig:async config=>{if(fail)throw Error('保存失败测试');return {ok:true,config};}}),view=await h.mount(Settings,{store});
 assert.equal(h.button(view.container.querySelector('.settings-topbar'),'关闭'),undefined);
 await h.act(async()=>store.setJson('{ invalid draft'));
 await h.act(async()=>window.requestSettingsClose());assert.ok(document.querySelector('[role=dialog]'));await h.click(h.button(document.body,'取消'));assert.equal(document.querySelector('[role=dialog]'),null);assert.equal(closed,0);assert.equal(store.snapshot().jsonText,'{ invalid draft');
 await h.act(async()=>window.requestSettingsClose());await h.click(h.button(document.body,'保留草稿并关闭'));assert.equal(closed,1);assert.ok([...Array(localStorage.length)].some((_,i)=>localStorage.getItem(localStorage.key(i)).includes('invalid draft')));
 await h.click(h.button(document.body,'取消'));await h.act(async()=>{store.restoreJson(null);store.edit(c=>{c.core.launchAtLogin=true;});window.requestSettingsClose();});
 await h.click(h.button(document.body,'保存并关闭'));assert.equal(closed,1);assert.match(document.querySelector('[role=dialog] [role=alert]').textContent,/保存失败测试/);
 fail=false;await h.click(h.button(document.body,'保存并关闭'));assert.equal(closed,2);assert.equal(store.dirty,false);assert.equal(localStorage.length,0);
 await view.unmount();store.dispose();
});
test('a close during saving waits for success and never bypasses a failed save',async()=>{
 let closed=0,prompted=0;
 const {store}=await h.loaded({closeSettings:async()=>closed++}),dispose=bindSettingsClose(store,()=>prompted++);
 store.edit(c=>{c.core.launchAtLogin=true;});store.patch({busy:true});window.requestSettingsClose();store.patch({busy:false});await new Promise(resolve=>setImmediate(resolve));assert.equal(prompted,1);assert.equal(closed,0);
 store.patch({busy:true});window.requestSettingsClose();store.patch({saved:h.model.clone(store.snapshot().config),busy:false});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
 dispose();store.dispose();
});
