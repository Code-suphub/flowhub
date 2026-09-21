const {test}=require('node:test'),assert=require('node:assert/strict');const h=require('./settings-harness.test.cjs');
test('history list, preview, restore, unchanged results and restart/path warnings remain visible',async()=>{
 let restored=[],unchanged=false;const {store}=await h.loaded({listConfigHistory:async()=>({entries:[{id:'one',created_at:1758096000000,bytes:2048,catalog_count:7}],limit:20}),previewConfigHistory:async()=>({config:{core:{hotkey:'Other'}}}),restoreConfigHistory:async id=>{restored.push(id);return {unchanged,warnings:['存储位置不同']};}});
 const {DataPanel}=require('../../src/settings/Core.tsx'),view=await h.mount(DataPanel,{store});assert.match(view.container.textContent,/7 项/);assert.match(view.container.textContent,/2048 B/);
 await h.click(h.button(view.container,'预览'));assert.match(document.querySelector('dialog').textContent,/Other/);await h.click(document.querySelector('dialog [aria-label="关闭"]'));
 await h.click(h.button(view.container,'恢复'));await h.click(h.button(document.body,'确认恢复'));assert.deepEqual(restored,['one']);assert.match(store.snapshot().notice,/重启/);assert.match(store.snapshot().notice,/存储位置/);
 unchanged=true;await h.click(h.button(view.container,'恢复'));await h.click(h.button(document.body,'确认恢复'));assert.match(store.snapshot().notice,/相同/);
 await view.unmount();store.dispose();
});
test('unavailable history, failed preview/restore and missing API are handled without mutation',async()=>{
 const {store}=await h.loaded({listConfigHistory:async()=>({entries:[],available:false})});const {DataPanel}=require('../../src/settings/Core.tsx'),view=await h.mount(DataPanel,{store});assert.match(view.container.textContent,/浏览器预览不提供/);
 delete window.weborg.listConfigHistory;await h.act(async()=>store.refreshHistory());assert.match(store.snapshot().history.error,/不支持/);assert.equal(store.dirty,false);await view.unmount();store.dispose();
});
test('restore locks IPC through metadata reread against duplicate restores, save and close',async()=>{
 let releaseRestore,releaseMetadata,restores=0,saves=0,reading=false;
 const restored=h.fixture();restored.core.hotkey='F8';
 const {store}=await h.loaded({listConfigHistory:async()=>({entries:[{id:'one',created_at:1}]}),restoreConfigHistory:async()=>{restores++;await new Promise(r=>releaseRestore=r);reading=true;return {ok:true};},saveConfig:async()=>{saves++;return {ok:true};},getConfig:async()=>reading?restored:h.fixture(),getConfigPathInfo:async()=>{if(reading)await new Promise(r=>releaseMetadata=r);return {activePath:'/config/A'};}});
 const {DataPanel}=require('../../src/settings/Core.tsx'),view=await h.mount(DataPanel,{store});await h.click(h.button(view.container,'恢复'));await h.click(h.button(document.body,'确认恢复'));
 assert.equal(restores,1);assert.equal(store.snapshot().busy,true);assert.equal(document.querySelector('dialog [aria-label="关闭"]').disabled,true);assert.equal(h.button(document.body,'确认恢复').disabled,true);
 await assert.rejects(store.restoreHistory('two'),/正在进行/);await store.save();await store.reset();assert.equal(saves,0);assert.equal(restores,1);
 await h.act(async()=>releaseRestore());assert.equal(store.snapshot().busy,true);assert.equal(store.snapshot().config.core.hotkey,'Alt+Space');await store.save();assert.equal(saves,0);
 await h.act(async()=>releaseMetadata());assert.equal(store.snapshot().busy,false);assert.equal(store.snapshot().config.core.hotkey,'F8');assert.equal(store.dirty,false);assert.equal(document.querySelector('dialog'),null);await view.unmount();store.dispose();
});
test('committed history with failed reread blocks saves until explicit reload, preserving JSON draft',async()=>{
 let committed=false,fail=true,saves=0;
 const {store}=await h.loaded({restoreConfigHistory:async()=>{committed=true;return {ok:true};},getConfig:async()=>{if(committed&&fail)throw Error('read failed');const c=h.fixture();if(committed)c.core.hotkey='F8';return c;},saveConfig:async()=>{saves++;return {ok:true};}});
 store.setJson('{"only-in-json":');await assert.rejects(store.restoreHistory('one'),/历史已提交/);assert.equal(store.snapshot().busy,false);assert.equal(store.snapshot().conflict,true);assert.equal(store.dirty,true);assert.equal(store.snapshot().jsonText,'{"only-in-json":');await assert.rejects(store.save(),/源草稿/);await assert.rejects(store.restoreHistory('two'),/显式重载/);assert.equal(saves,0);
 assert.ok(localStorage.length);fail=false;await store.reset();assert.equal(store.snapshot().config.core.hotkey,'F8');assert.equal(store.snapshot().conflict,false);assert.equal(store.dirty,false);assert.ok(localStorage.length,'source recovery survives target reload');store.dispose();
});
test('history restore error is rendered inside the open shared Dialog',async()=>{
 const {store}=await h.loaded({listConfigHistory:async()=>({entries:[{id:'one',created_at:1}]}),restoreConfigHistory:async()=>{throw Error('history unavailable');}});
 const {DataPanel}=require('../../src/settings/Core.tsx'),view=await h.mount(DataPanel,{store});await h.click(h.button(view.container,'恢复'));await h.click(h.button(document.body,'确认恢复'));assert.match(document.querySelector('dialog [role="alert"]').textContent,/history unavailable/);assert.equal(document.querySelector('dialog [aria-label="关闭"]').disabled,false);await view.unmount();store.dispose();
});
