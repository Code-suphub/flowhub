const {test}=require('node:test'),assert=require('node:assert/strict');const h=require('./settings-harness.test.cjs');
test('web import deduplicates IDs/URLs/file repeats and skips descendants of skipped folders',()=>{
 const nodes=h.fixture().plugins.web.settings.items;
 const incoming=[{id:'a',children:[{id:'a9'}]},{id:'p2',url:'https://example.test/'},{id:'n1',children:[{id:'n1a'}]},{id:'n1'},{id:'n2',url:'https://n2.test/'}];
 const plan=h.model.importWeb(nodes,incoming,false);
 assert.deepEqual(plan.nodes.slice(-2).map(n=>n.id),['n1','n2']);assert.equal(plan.nodes.at(-2).children[0].id,'n1a');
 assert.equal(h.model.entries(plan.nodes).some(e=>['p2','a9'].includes(e.node.id)),false);assert.equal(plan.changes.filter(v=>v.startsWith('跳过')).length,3);
 assert.equal(nodes.length,5);assert.equal(incoming[2].children.length,1);
});
test('overwrite retains location/existing descendants and applies nested replacements; plans undo atomically',async()=>{
 const {store}=await h.loaded(), original=h.model.clone(store.snapshot().config.plugins.web.settings.items);
 const plan=h.model.importWeb(original,[{id:'a',title:'新标题',accent:'blue',children:[{id:'a3',title:'新增'}]},{id:'a1',title:'改过'}],true);
 assert.equal(plan.nodes[0].title,'新标题');assert.equal(plan.nodes[0].accent,'blue');assert.deepEqual(plan.nodes[0].children.map(n=>n.id),['a1','a2','a3']);assert.equal(plan.nodes[0].children[0].title,'改过');
 store.edit(c=>{c.plugins.web.settings.items=plan.nodes;});store.travel('undo');assert.deepEqual(store.snapshot().config.plugins.web.settings.items,original);
 const duplicate=h.model.importWeb(original,[{id:'a'}],false);store.edit(c=>{c.plugins.web.settings.items=duplicate.nodes;});assert.equal(store.snapshot().undo.length,0);store.dispose();
});
test('web file picker previews before applying, cancels cleanly and surfaces empty/error files',async()=>{
 let result={path:'/mock/web.json',items:[{id:'new',title:'New'}]}; const {store,writes}=await h.loaded({pickWebImport:async()=>result}),{WebCatalog}=require('../../src/settings/Collections.tsx'),view=await h.mount(WebCatalog,{store});
 await h.click(h.button(view.container,'导入…'));assert.match(document.body.textContent,/新增：new/);assert.equal(store.dirty,false);
 await h.click(document.querySelector('dialog [aria-label="关闭"]'));assert.equal(store.dirty,false);
 await h.click(h.button(view.container,'导入…'));await h.click(h.button(document.body,'应用为草稿'));assert.equal(store.snapshot().config.plugins.web.settings.items.at(-1).id,'new');assert.equal(writes.length,0);
 result={canceled:true};await h.click(h.button(view.container,'导入…'));assert.equal(document.querySelector('dialog'),null);
 result={items:[]};await h.click(h.button(view.container,'导入…'));assert.match(store.snapshot().notice,/没有网页节点/);
 window.weborg.pickWebImport=async()=>{throw new Error('不是有效 JSON');};await h.click(h.button(view.container,'导入…'));assert.match(store.snapshot().notice,/不是有效 JSON/);
 await view.unmount();store.dispose();
});
