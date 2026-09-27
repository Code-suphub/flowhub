const {test}=require('node:test'),assert=require('node:assert/strict');const h=require('./settings-harness.test.cjs');
test('menu scans are invisible-page gated and concurrent requests share one native request',async()=>{
 let managementCalls=0,scans=0,resolve;const {store}=await h.loaded();store.edit(c=>{c.core.menuBar.organizerEnabled=true;});
 window.weborg.getMenuBarManagementState=()=>{managementCalls++;return new Promise(r=>{resolve=r;});};window.weborg.listMenuBarItems=async()=>{scans++;return {items:[]};};
 const {Core}=require('../../src/settings/Core.tsx');const view=await h.mount(Core,{store,section:'general',onSection:()=>{}});window.dispatchEvent(new window.Event('focus'));assert.equal(managementCalls,0);
 let a,b;await h.act(async()=>{a=store.refreshMenu();b=store.refreshMenu();});assert.equal(a,b);assert.equal(managementCalls,1);await h.act(async()=>{resolve({trusted:true});await a;});assert.equal(scans,1);
 await h.act(async()=>view.root.render(h.React.createElement(Core,{store,section:'menubar',onSection:()=>{}})));assert.equal(managementCalls,2);
 window.dispatchEvent(new window.Event('focus'));assert.equal(managementCalls,2);
 await h.act(async()=>view.root.render(h.React.createElement(Core,{store,section:'general',onSection:()=>{}})));await h.act(async()=>{resolve({trusted:true});await store.refreshMenu();});
 window.dispatchEvent(new window.Event('focus'));assert.equal(managementCalls,2);await view.unmount();store.dispose();
});
test('memo hierarchy merges ancestors, counts descendants and emits each memo once',()=>{
 const tree=h.model.memoTree([{id:'p',title:'Parent',category:'编程'},{id:'n',title:'Nested',category:'编程 / 数据库 / MySQL'},{id:'s',title:'Sibling',category:'编程 / 数据库 / PostgreSQL'}]);
 assert.equal(tree.count,3);assert.equal(tree.children.length,1);assert.equal(tree.children[0].count,3);assert.equal(tree.children[0].children[0].children.length,2);
 const collect=b=>[...b.items,...b.children.flatMap(collect)];assert.deepEqual(collect(tree).map(i=>i.id).sort(),['n','p','s']);assert.equal(h.model.memoTree([]).children.length,0);
});
test('memo category independent collapse, recursive search expansion, clearing filter restores collapse',async()=>{
 const {store}=await h.loaded(),{Memos}=require('../../src/settings/Collections.tsx'),view=await h.mount(Memos,{store});
 const group=path=>view.container.querySelector('[data-memo-category="'+path+'"]');
 assert.equal(group('编程').getAttribute('aria-expanded'),'true');await h.click(group('编程 / 数据库 / MySQL'));assert.equal(group('编程 / 数据库 / MySQL').getAttribute('aria-expanded'),'false');assert.equal(group('编程 / 数据库 / PostgreSQL').getAttribute('aria-expanded'),'true');
 await h.click(group('编程'));assert.equal(group('编程').getAttribute('aria-expanded'),'false');
 await h.input(view.container.querySelector('[aria-label="筛选备忘录"]'),'MySQL');
 for(const path of ['编程','编程 / 数据库','编程 / 数据库 / MySQL'])assert.equal(group(path).getAttribute('aria-expanded'),'true');assert.equal(group('编程 / 数据库 / PostgreSQL'),null);
 await h.input(view.container.querySelector('[aria-label="筛选备忘录"]'),'');assert.equal(group('编程').getAttribute('aria-expanded'),'false');
 await view.unmount();store.dispose();
});
test('memo delete/default reset are shared Dialog confirmations and do not mutate before confirmation',async()=>{
 const {store}=await h.loaded(),{Memos}=require('../../src/settings/Collections.tsx'),view=await h.mount(Memos,{store});
 await h.click(h.button(view.container,'删除备忘'));assert.equal(store.dirty,false);await h.click(document.querySelector('[role="dialog"] [aria-label="关闭"]'));assert.equal(store.dirty,false);
 await h.click(h.button(view.container,'恢复内置'));assert.equal(store.dirty,false);await h.click(h.button(document.body,'确认'));assert.equal(store.snapshot().config.plugins.memo.settings.items,undefined);
 await h.act(async()=>store.travel('undo'));assert.equal(store.snapshot().config.plugins.memo.settings.items.length,2);
 await h.click(h.button(view.container,'删除备忘'));await h.click(h.button(document.body,'确认'));assert.equal(store.snapshot().config.plugins.memo.settings.items.length,1);
 await view.unmount();store.dispose();
});
test('memo category rename changes descendants only with path boundaries',()=>{
 const items=[{id:'a',title:'A',category:'A'},{id:'b',title:'B',category:'A / B'},{id:'c',title:'C',category:'AB / C'}];h.model.renameCategory(items,'A','X','a');assert.equal(items[1].category,'X / B');assert.equal(items[2].category,'AB / C');
});
test('memo dragging reorders items and categories without losing descendants',()=>{
 const items=[
  {id:'a',title:'A',category:'编程 / 数据库 / MySQL'},
  {id:'b',title:'B',category:'编程 / 数据库 / MySQL'},
  {id:'p',title:'P',category:'编程 / 数据库 / PostgreSQL'},
  {id:'d',title:'D',category:'编程 / 容器 / Docker'}
 ];
 const item=h.model.moveMemo(items,{kind:'item',id:'b'},{kind:'item',id:'a'},'before');
 assert.deepEqual(item.map(entry=>entry.id),['b','a','p','d']);
 const across=h.model.moveMemo(items,{kind:'item',id:'b'},{kind:'category',id:'编程 / 容器 / Docker'},'inside');
 assert.equal(across.find(entry=>entry.id==='b').category,'编程 / 容器 / Docker');
 assert.deepEqual(across.map(entry=>entry.id),['a','p','d','b']);
 const sibling=h.model.moveMemo(items,{kind:'category',id:'编程 / 数据库 / MySQL'},{kind:'category',id:'编程 / 数据库 / PostgreSQL'},'after');
 assert.deepEqual(sibling.map(entry=>entry.id),['p','a','b','d']);
 const nested=h.model.moveMemo(items,{kind:'category',id:'编程 / 数据库 / MySQL'},{kind:'category',id:'编程 / 容器'},'inside');
 assert.deepEqual(nested.filter(entry=>['a','b'].includes(entry.id)).map(entry=>entry.category),['编程 / 容器 / MySQL','编程 / 容器 / MySQL']);
 assert.deepEqual(nested.map(entry=>entry.id),['p','d','a','b']);
 assert.equal(h.model.moveMemo(items,{kind:'category',id:'编程 / 数据库'},{kind:'category',id:'编程 / 数据库 / MySQL'},'inside'),items);
 assert.deepEqual(items.map(entry=>entry.id),['a','b','p','d']);
});
test('memo browser preview can fold and temporarily drag categories without editing',async()=>{
 const {store,writes}=await h.loaded({},true),{Memos}=require('../../src/settings/Collections.tsx'),view=await h.mount(Memos,{store});
 const group=path=>view.container.querySelector('[data-memo-category="'+path+'"]');
 assert.equal(h.button(view.container,'新增备忘').disabled,true);
 assert.equal(view.container.querySelector('[aria-label="标题"]').readOnly,true);
 await h.click(group('编程 / 数据库 / MySQL'));
 assert.equal(group('编程 / 数据库 / MySQL').getAttribute('aria-expanded'),'false');
 const source=group('编程 / 数据库 / PostgreSQL'),target=group('编程 / 数据库 / MySQL');
 target.getBoundingClientRect=()=>({top:0,height:100});
 await h.act(async()=>{
  const start=new window.Event('dragstart',{bubbles:true,cancelable:true});Object.defineProperty(start,'dataTransfer',{value:{setData(){},effectAllowed:''}});source.dispatchEvent(start);
  const over=new window.Event('dragover',{bubbles:true,cancelable:true});Object.defineProperty(over,'clientY',{value:10});target.dispatchEvent(over);
 });
 assert.equal(target.dataset.dropPosition,'before');
 await h.act(async()=>{
  const drop=new window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'clientY',{value:10});target.dispatchEvent(drop);
 });
 assert.deepEqual([...view.container.querySelectorAll('[data-memo-category^="编程 / 数据库 / "][aria-level="3"]')].map(row=>row.dataset.memoKey),['编程 / 数据库 / PostgreSQL','编程 / 数据库 / MySQL']);
 assert.deepEqual(store.snapshot().config.plugins.memo.settings.items.map(entry=>entry.id),['m1','m2']);
 assert.equal(store.dirty,false);assert.equal(writes.length,0);
 await view.unmount();
 const reopened=await h.mount(Memos,{store});
 assert.deepEqual([...reopened.container.querySelectorAll('[data-memo-category^="编程 / 数据库 / "][aria-level="3"]')].map(row=>row.dataset.memoKey),['编程 / 数据库 / MySQL','编程 / 数据库 / PostgreSQL']);
 await reopened.unmount();store.dispose();
});
test('memo desktop drag creates an undoable draft',async()=>{
 const {store}=await h.loaded(),{Memos}=require('../../src/settings/Collections.tsx'),view=await h.mount(Memos,{store});
 const source=view.container.querySelector('[data-memo-key="m2"]'),target=view.container.querySelector('[data-memo-key="m1"]');
 target.getBoundingClientRect=()=>({top:0,height:100});
 await h.act(async()=>{
  const start=new window.Event('dragstart',{bubbles:true,cancelable:true});Object.defineProperty(start,'dataTransfer',{value:{setData(){},effectAllowed:''}});source.dispatchEvent(start);
  const drop=new window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'clientY',{value:10});target.dispatchEvent(drop);
 });
 assert.deepEqual(store.snapshot().config.plugins.memo.settings.items.map(entry=>entry.id),['m2','m1']);
 assert.equal(store.dirty,true);
 await h.act(async()=>store.travel('undo'));
 assert.deepEqual(store.snapshot().config.plugins.memo.settings.items.map(entry=>entry.id),['m1','m2']);
 await view.unmount();store.dispose();
});
