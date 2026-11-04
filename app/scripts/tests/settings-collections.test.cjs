const {test}=require('node:test'),assert=require('node:assert/strict');
const h=require('./settings-harness.test.cjs');
const {WebCatalog,Memos}=require('../../src/settings/Collections.tsx');
const flush=()=>h.act(async()=>new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve))));
const row=(view,id)=>view.container.querySelector(`[data-node-id="${id}"]`);
const dialog=()=>document.querySelector('[role=dialog]');
const items=store=>store.snapshot().config.plugins.web.settings.items;
async function menu(view,label,item){
  await h.click(view.container.querySelector(`[aria-label="${label}"]`));
  await h.click([...document.querySelectorAll('[role=menuitem]')].find(node=>node.textContent===item));
}
async function selectMany(view,ids){for(const id of ids)await h.key(row(view,id),'Enter',{ctrlKey:true});}

test('multiple selections get a dedicated editor; deletion counts unique branches, cancels safely and undoes once',async()=>{
  const {store,writes}=await h.loaded(),view=await h.mount(WebCatalog,{store}),before=h.model.clone(items(store));
  await selectMany(view,['a','a1','b']);
  assert.match(view.container.textContent,/已选择 3 项/);assert.equal(view.container.querySelector('input[aria-label="标题"]'),null);
  await h.click(h.button(view.container,'删除所选…'));
  assert.match(dialog().textContent,/2 个分支，共 4 个节点（含 2 个子节点）/);
  await h.click(h.button(dialog(),'取消'));assert.deepEqual(items(store),before);
  await h.click(h.button(view.container,'删除所选…'));await h.click(h.button(dialog(),'确认删除'));
  assert.deepEqual(items(store).map(node=>node.id),['c','d','p']);assert.equal(store.snapshot().undo.length,1);assert.equal(writes.length,0);
  await h.act(async()=>store.travel('undo'));assert.deepEqual(items(store),before);assert.match(view.container.textContent,/已选择 3 项/);
  await view.unmount();store.dispose();
});
test('bulk move excludes self and descendants, preserves order and records one draft action',async()=>{
  const {store,writes}=await h.loaded(),view=await h.mount(WebCatalog,{store});await selectMany(view,['a','a1','b']);
  await h.click(h.button(view.container,'移动所选…'));await h.click(dialog().querySelector('[aria-label="目标目录"]'));
  const options=[...document.querySelectorAll('[role=option]')];assert.deepEqual(options.map(node=>node.textContent),['根目录','C','C / C1','D']);
  await h.click(options.find(node=>node.textContent==='C'));await h.click(h.button(dialog(),'确认移动'));
  assert.deepEqual(items(store).map(node=>node.id),['c','d','p']);assert.deepEqual(items(store)[0].children.map(node=>node.id),['c1','a','b']);
  assert.deepEqual(items(store)[0].children[1].children.map(node=>node.id),['a1','a2']);assert.equal(store.snapshot().undo.length,1);assert.equal(writes.length,0);
  await h.act(async()=>store.travel('undo'));assert.deepEqual(items(store).map(node=>node.id),['a','b','c','d','p']);
  await view.unmount();store.dispose();
});
test('an open web confirmation rejects a changed catalog instead of acting on stale details',async()=>{
  const {store}=await h.loaded(),view=await h.mount(WebCatalog,{store});await h.click(row(view,'a'));await menu(view,'节点操作','删除节点…');
  await h.act(async()=>store.edit(c=>{c.plugins.web.settings.items[0].children.push({id:'late',title:'迟到节点'});}));
  const before=JSON.stringify(items(store));await h.click(h.button(dialog(),'确认删除'));
  assert.match(dialog().querySelector('[role=alert]').textContent,/目录已变化/);assert.equal(JSON.stringify(items(store)),before);assert.equal(h.button(dialog(),'确认删除').disabled,true);
  await h.click(h.button(dialog(),'取消'));await view.unmount();store.dispose();
});
test('new web nodes clear filters, reveal ancestors and focus an associated title field',async()=>{
  const {store,writes}=await h.loaded(),view=await h.mount(WebCatalog,{store});
  await h.input(view.container.querySelector('[aria-label="筛选网页目录"]'),'A1');await h.click(row(view,'a1'));await menu(view,'节点操作','添加子节点');await flush();
  const title=view.container.querySelector('input[aria-label="标题"]'),added=h.model.entries(items(store)).find(entry=>entry.node.title==='新节点');
  assert.equal(added.parent.id,'a1');assert.equal(view.container.querySelector('[aria-label="筛选网页目录"]').value,'');assert.ok(row(view,added.node.id));assert.equal(document.activeElement===title,true);assert.ok(view.container.querySelector(`label[for="${title.id}"]`));
  await h.input(title,'我的网页');assert.equal(view.container.querySelector('input[aria-label="标题"]')===title,true);assert.equal(h.model.entries(items(store)).find(entry=>entry.node.id===added.node.id).node.title,'我的网页');assert.equal(writes.length,0);
  await h.click(view.container.querySelector('[aria-label="返回网页列表"]'));await flush();assert.equal(view.container.querySelector('.settings-collection').dataset.detailOpen,'false');assert.equal(document.activeElement===row(view,added.node.id),true);
  await view.unmount();store.dispose();
});
test('native import stays a reviewable draft and can be undone as a single action',async()=>{
  let picks=0;const {store,writes}=await h.loaded({pickWebImport:async()=>{picks++;return {path:'/fixture/catalog.json',items:[{id:'imported',title:'导入网页',url:'https://example.test/new'}]};}}),view=await h.mount(WebCatalog,{store});
  await menu(view,'目录操作','导入目录…');assert.match(dialog().textContent,/新增：imported/);assert.equal(items(store).some(node=>node.id==='imported'),false);
  await h.click(h.button(dialog(),'应用为草稿'));assert.equal(items(store).at(-1).id,'imported');assert.equal(store.snapshot().undo.length,1);assert.equal(writes.length,0);assert.equal(picks,1);
  await h.act(async()=>store.travel('undo'));assert.equal(items(store).some(node=>node.id==='imported'),false);await view.unmount();store.dispose();
});
test('memo creation clears filters and stale metadata, focuses title and preserves content editing',async()=>{
  const {store,writes}=await h.loaded(),view=await h.mount(Memos,{store});
  await h.input(view.container.querySelector('[aria-label="筛选备忘录"]'),'select 2');await h.click(h.button(view.container,'新增备忘'));await flush();
  const title=view.container.querySelector('input[aria-label="标题"]');assert.equal(document.activeElement===title,true);assert.equal(title.value,'新备忘');assert.equal(view.container.querySelector('[aria-label="筛选备忘录"]').value,'');assert.equal(view.container.querySelector('[aria-label="分类路径"]').value,'其他');
  await h.input(title,'临时命令');await h.input(view.container.querySelector('textarea[aria-label="命令或备忘内容"]'),'printf example');
  assert.equal(store.snapshot().config.plugins.memo.settings.items.at(-1).content,'printf example');assert.equal(writes.length,0);
  await menu(view,'备忘操作','删除备忘…');assert.match(dialog().textContent,/临时命令/);await h.click(h.button(dialog(),'取消'));assert.equal(store.snapshot().config.plugins.memo.settings.items.length,3);
  await menu(view,'备忘操作','删除备忘…');await h.click(h.button(dialog(),'确认删除'));assert.equal(store.snapshot().config.plugins.memo.settings.items.length,2);
  await h.act(async()=>store.travel('undo'));assert.equal(store.snapshot().config.plugins.memo.settings.items.at(-1).title,'临时命令');
  await view.unmount();store.dispose();
});
test('memo reset needs explicit confirmation and restores built-ins with one undoable draft',async()=>{
  const {store,writes}=await h.loaded(),view=await h.mount(Memos,{store});await menu(view,'备忘录操作','恢复内置备忘录…');assert.match(dialog().textContent,/2 条自定义备忘/);
  await h.click(h.button(dialog(),'确认恢复'));assert.equal(store.snapshot().config.plugins.memo.settings.items,undefined);assert.equal(view.container.querySelector('input[aria-label="标题"]').value,'默认');assert.equal(store.snapshot().undo.length,1);assert.equal(writes.length,0);
  await h.act(async()=>store.travel('undo'));assert.equal(store.snapshot().config.plugins.memo.settings.items.length,2);await view.unmount();store.dispose();
});
test('memo deletion refuses a stale confirmation after the underlying item changes',async()=>{
  const {store}=await h.loaded(),view=await h.mount(Memos,{store});await menu(view,'备忘操作','删除备忘…');
  await h.act(async()=>store.edit(c=>{c.plugins.memo.settings.items[0].title='已更新';}));await h.click(h.button(dialog(),'确认删除'));
  assert.match(dialog().querySelector('[role=alert]').textContent,/备忘录已变化/);assert.equal(store.snapshot().config.plugins.memo.settings.items.length,2);await h.click(h.button(dialog(),'取消'));await view.unmount();store.dispose();
});
test('collection browsing and bulk review in browser preview never expose writable actions',async()=>{
  let calls=0;const {store,writes}=await h.loaded({pickWebImport:async()=>{calls++;}},true),before=JSON.stringify(store.snapshot().config),view=await h.mount(WebCatalog,{store});
  await h.click(h.button(view.container,'多选'));await h.click(row(view,'a'));await h.click(row(view,'b'));
  assert.equal(h.button(view.container,'移动所选…').disabled,true);assert.equal(h.button(view.container,'删除所选…').disabled,true);assert.equal(h.button(view.container,'新建节点').disabled,true);
  await h.click(view.container.querySelector('[aria-label="目录操作"]'));assert.equal([...document.querySelectorAll('[role=menuitem]')].find(node=>node.textContent==='导入目录…').hasAttribute('data-disabled'),true);
  await h.key(document.querySelector('[role=menu]'),'Escape');assert.equal(JSON.stringify(store.snapshot().config),before);assert.equal(writes.length,0);assert.equal(calls,0);await view.unmount();store.dispose();
});
test('an empty detail still offers a list return, and queued focus does not override newer keyboard input',async()=>{
  const {store}=await h.loaded(),view=await h.mount(WebCatalog,{store});await h.click(row(view,'a'));await flush();
  await h.act(async()=>store.edit(c=>{c.plugins.web.settings.items=[];}));
  const back=view.container.querySelector('[aria-label="返回网页列表"]');assert.ok(back);await h.click(back);
  const search=view.container.querySelector('[aria-label="筛选网页目录"]');await h.key(search,'ArrowLeft');await flush();assert.equal(document.activeElement===search,true);assert.equal(view.container.querySelector('.settings-collection').dataset.detailOpen,'false');
  await view.unmount();store.dispose();
});
test('a key pressed on a folder button does not activate the containing tree row',async()=>{
  const {store}=await h.loaded(),view=await h.mount(WebCatalog,{store});await h.key(row(view,'a').querySelector('button'),'Enter');
  assert.equal(view.container.querySelector('input[aria-label="标题"]'),null);assert.equal(store.dirty,false);await view.unmount();store.dispose();
});
