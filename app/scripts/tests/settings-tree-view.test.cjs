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
 const row=view.container.querySelector('[data-node-id="a1"]');await h.key(row,'Enter');assert.equal(row.getAttribute('aria-selected'),'true');
 await h.key(view.container.querySelector('[data-node-id="b"]'),'Enter',{ctrlKey:true});assert.match(view.container.textContent,/删除 2/);
 const divider=view.container.querySelector('[role=separator]');await h.key(divider,'End');assert.equal(divider.getAttribute('aria-valuenow'),'380');await h.key(divider,'Home');assert.equal(divider.getAttribute('aria-valuenow'),'220');
 await h.input(view.container.querySelector('[aria-label="筛选网页目录"]'),'A1');assert.deepEqual([...view.container.querySelectorAll('[data-node-id]')].map(e=>e.dataset.nodeId),['a','a1']);
 await view.unmount();store.dispose();
});
