const {test}=require('node:test'),assert=require('node:assert/strict');const h=require('./settings-harness.test.cjs');
test('web and memo deletion restore exact positions; redo and successful save clear stale undo',async()=>{
 const {store}=await h.loaded();const original=h.model.clone(store.snapshot().config);
 store.edit(c=>{c.plugins.web.settings.items=h.model.removeNodes(c.plugins.web.settings.items,['a']);});
 assert.equal(store.snapshot().config.plugins.web.settings.items.length,4);assert.equal(store.snapshot().undo.length,1);
 store.travel('undo');assert.deepEqual(store.snapshot().config,original);store.travel('redo');assert.equal(store.snapshot().config.plugins.web.settings.items.length,4);
 store.travel('undo');store.edit(c=>{c.plugins.memo.settings.items.splice(1,1);});assert.equal(store.snapshot().config.plugins.memo.settings.items.length,1);store.travel('undo');assert.deepEqual(store.snapshot().config.plugins.memo.settings.items,original.plugins.memo.settings.items);
 store.edit(c=>{c.core.hotkey='F1';});await store.save();assert.equal(store.snapshot().undo.length,0);assert.equal(store.snapshot().redo.length,0);store.travel('undo');assert.equal(store.snapshot().config.core.hotkey,'F1');store.dispose();
});
test('invalid or repeated no-op movement does not manufacture an undo snapshot',async()=>{const {store}=await h.loaded();store.edit(c=>{c.plugins.web.settings.items=h.model.moveNodes(c.plugins.web.settings.items,['a'],'a1');});assert.equal(store.snapshot().undo.length,0);store.dispose();});
