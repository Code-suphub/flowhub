const {test}=require('node:test'),assert=require('node:assert/strict');const h=require('./settings-harness.test.cjs');
const {useTreeView}=require('../../src/settings/useTreeView.ts');
function Tree({ids,selected='',filter=''}){const view=useTreeView(ids,selected,filter);return h.React.createElement('div',{ref:view.ref,onScroll:view.capture,role:'tree'},ids.map(id=>h.React.createElement('div',{'data-node-id':id,tabIndex:0,key:id},id)));}
test('tree preserves scroll anchor/focus on insertion, field updates do not reset scroll, filter and empty reset',async()=>{
 h.environment();Object.defineProperty(window.HTMLElement.prototype,'offsetTop',{configurable:true,get(){return this.dataset.nodeId?[...this.parentElement.children].indexOf(this)*30:0;}});Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return 30;}});Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{configurable:true,get(){return 90;}});
 const ids=Array.from({length:12},(_,i)=>'n'+i),view=await h.mount(Tree,{ids}),tree=view.container.firstChild;
 tree.scrollTop=150;tree.dispatchEvent(new window.Event('scroll'));view.container.querySelector('[data-node-id="n7"]').focus();
 await h.act(async()=>view.root.render(h.React.createElement(Tree,{ids:['x0','x1','x2','x3','x4',...ids]})));
 assert.equal(tree.scrollTop,300);assert.equal(document.activeElement.dataset.nodeId,'n7');
 await h.act(async()=>view.root.render(h.React.createElement(Tree,{ids:['x0','x1','x2','x3','x4',...ids]})));assert.equal(tree.scrollTop,300);
 await h.act(async()=>view.root.render(h.React.createElement(Tree,{ids:['n11'],filter:'n11'})));assert.equal(tree.scrollTop,0);
 await h.act(async()=>view.root.render(h.React.createElement(Tree,{ids,filter:''})));assert.equal(tree.scrollTop,0);
 tree.scrollTop=150;tree.dispatchEvent(new window.Event('scroll'));await h.act(async()=>view.root.render(h.React.createElement(Tree,{ids:ids.filter(id=>id!=='n5')})));assert.equal(tree.scrollTop,150);
 await h.act(async()=>view.root.render(h.React.createElement(Tree,{ids:[]})));assert.equal(tree.scrollTop,0);await view.unmount();
});
test('selection reveals only when changed; repeated selection respects user scroll',async()=>{
 h.environment();const ids=Array.from({length:12},(_,i)=>'n'+i),view=await h.mount(Tree,{ids,selected:'n0'}),tree=view.container.firstChild;
 await h.act(async()=>view.root.render(h.React.createElement(Tree,{ids,selected:'n9'})));assert.equal(tree.scrollTop,210);
 tree.scrollTop=0;await h.act(async()=>view.root.render(h.React.createElement(Tree,{ids,selected:'n9'})));assert.equal(tree.scrollTop,0);await view.unmount();
});
test('web tree search, keyboard selection, multi-selection and resize operate on React controls',async()=>{
 const {store}=await h.loaded(),{WebCatalog}=require('../../src/settings/Collections.tsx'),view=await h.mount(WebCatalog,{store});
 assert.equal(view.container.querySelector('.settings-catalog-actions'),null);
 const row=view.container.querySelector('[data-node-id="a1"]');await h.key(row,'Enter');assert.equal(row.getAttribute('aria-selected'),'true');
 assert.ok(view.container.querySelector('.settings-catalog-actions'));
 await h.key(view.container.querySelector('[data-node-id="b"]'),'Enter',{ctrlKey:true});assert.match(view.container.textContent,/删除 2/);
 const divider=view.container.querySelector('[role=separator]');await h.key(divider,'End');assert.equal(divider.getAttribute('aria-valuenow'),'380');await h.key(divider,'Home');assert.equal(divider.getAttribute('aria-valuenow'),'220');
 await h.input(view.container.querySelector('[aria-label="筛选网页目录"]'),'A1');assert.deepEqual([...view.container.querySelectorAll('[data-node-id]')].map(e=>e.dataset.nodeId),['a','a1']);
 await view.unmount();store.dispose();
});
test('browser preview reorders only its in-memory tree and keeps editing unavailable',async()=>{
 const {store,writes}=await h.loaded({},true),{WebCatalog}=require('../../src/settings/Collections.tsx'),view=await h.mount(WebCatalog,{store});
 const roots=()=>[...view.container.querySelectorAll('[role=treeitem][aria-level="1"]')].map(row=>row.dataset.nodeId);
 assert.deepEqual(roots(),['a','b','c','d','p']);
 assert.equal(h.button(view.container,'＋ 添加节点').disabled,true);
 assert.equal(view.container.querySelector('[aria-label="筛选网页目录"]').disabled,false);
 assert.equal(view.container.querySelector('[data-node-id="b"]').draggable,false);
 assert.ok(view.container.querySelector('[data-node-id="p"] .settings-tree-leaf svg'));
 const source=view.container.querySelector('[data-node-id="b"]'),target=view.container.querySelector('[data-node-id="a"]');
 target.getBoundingClientRect=()=>({top:0,height:100});
 document.elementFromPoint=()=>target;
 const pointer=(type,element,y)=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{pointerId:1,pointerType:'mouse',button:0,clientX:10,clientY:y});element.dispatchEvent(event);};
 await h.act(async()=>{pointer('pointerdown',source.querySelector('.settings-drag-handle'),40);pointer('pointermove',window,10);});
 assert.equal(target.dataset.dropPosition,'before');
 await h.act(async()=>pointer('pointerup',window,10));
 assert.equal(view.container.querySelector('[data-drop-position]'),null);
 assert.deepEqual(roots(),['b','a','c','d','p']);
 assert.deepEqual(store.snapshot().config.plugins.web.settings.items.map(node=>node.id),['a','b','c','d','p']);
 assert.equal(store.dirty,false);assert.equal(writes.length,0);
 await view.unmount();
 const again=await h.mount(WebCatalog,{store});assert.deepEqual([...again.container.querySelectorAll('[role=treeitem][aria-level="1"]')].map(row=>row.dataset.nodeId),['a','b','c','d','p']);
 await again.unmount();store.dispose();
});
test('desktop web tree pointer drag updates draft, while a click-sized motion does not reorder',async()=>{
 const {store}=await h.loaded(),{WebCatalog}=require('../../src/settings/Collections.tsx'),view=await h.mount(WebCatalog,{store});
 const source=view.container.querySelector('[data-node-id="b"]'),target=view.container.querySelector('[data-node-id="a"]');
 target.getBoundingClientRect=()=>({top:0,height:100});
 document.elementFromPoint=()=>target;
 const pointer=(type,element,y)=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{pointerId:2,pointerType:'mouse',button:0,clientX:10,clientY:y});element.dispatchEvent(event);};
 await h.act(async()=>{pointer('pointerdown',source,40);pointer('pointermove',window,38);pointer('pointerup',window,38);});
 assert.deepEqual(store.snapshot().config.plugins.web.settings.items.map(node=>node.id),['a','b','c','d','p']);
 await h.act(async()=>{pointer('pointerdown',source,40);pointer('pointermove',window,10);pointer('pointerup',window,10);});
 assert.deepEqual(store.snapshot().config.plugins.web.settings.items.map(node=>node.id),['b','a','c','d','p']);
 assert.equal(store.dirty,true);
 await view.unmount();store.dispose();
});
