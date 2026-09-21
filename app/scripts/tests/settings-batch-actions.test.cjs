const { test }=require('node:test'),assert=require('node:assert/strict');
const h=require('./settings-harness.test.cjs');
test('batch deletion collapses descendant selections, undo restores branch order and descendants',async()=>{
 const {store}=await h.loaded(), original=h.model.clone(store.snapshot().config.plugins.web.settings.items);
 store.edit(c=>{c.plugins.web.settings.items=h.model.removeNodes(c.plugins.web.settings.items,['a','a1','b']);});
 assert.deepEqual(store.snapshot().config.plugins.web.settings.items.map(n=>n.id),['c','d','p']);
 store.travel('undo');assert.deepEqual(store.snapshot().config.plugins.web.settings.items,original);assert.equal(store.snapshot().undo.length,0);
 store.dispose();
});
test('batch moves preserve order, reject self/descendant cycles and support root/before/after',()=>{
 const nodes=h.fixture().plugins.web.settings.items;
 const moved=h.model.moveNodes(nodes,['b','d'],'c');
 assert.deepEqual(moved.map(n=>n.id),['a','c','p']);assert.deepEqual(moved[1].children.map(n=>n.id),['c1','b','d']);
 assert.equal(h.model.moveNodes(nodes,['a'],'a1'),nodes);assert.equal(h.model.moveNodes(nodes,['a'],'a'),nodes);assert.equal(h.model.moveNodes(nodes,['a'],'missing'),nodes);
 const roots=h.model.moveNodes(nodes,['a1','a2'],'');assert.deepEqual(roots.slice(-2).map(n=>n.id),['a1','a2']);assert.equal(roots[0].children.length,0);
 assert.deepEqual(h.model.moveNodes(nodes,['d'],'a','before').map(n=>n.id),['d','a','b','c','p']);
 assert.deepEqual(h.model.moveNodes(nodes,['a'],'d','after').map(n=>n.id),['b','c','d','a','p']);
 assert.deepEqual(nodes.map(n=>n.id),['a','b','c','d','p'],'pure plans never mutate original');
});
