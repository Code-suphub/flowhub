const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {setup,wait,delay}=require('./search-react-harness.cjs');
test('clipboard deletion uses shared dialog; cancel/Escape send no delete, confirmation sends once with explicit flag',async t=>{
  const {w,q,scope,key,calls}=await setup(t);await scope('clipboard');q.focus();
  // jsdom allows focus inside a closed dialog; browsers keep those controls inert.
  const focus=w.HTMLElement.prototype.focus;
  w.HTMLElement.prototype.focus=function(...args){if(this.closest('dialog:not([open])'))return;return focus.apply(this,args);};
  key('Backspace',{altKey:true});await wait(()=>w.document.querySelector('dialog[open]'));
  assert.equal(calls.filter(c=>c[0]==='action').length,0);
  const find=text=>[...w.document.querySelectorAll('dialog button')].find(b=>b.textContent===text);
  find('取消').click();await wait(()=>!w.document.querySelector('dialog'));await wait(()=>w.document.activeElement?.id==='q');
  w.document.querySelector('.clipboard-result').dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await wait(()=>find('确认删除'));
  w.document.querySelector('dialog').dispatchEvent(new w.Event('cancel',{cancelable:true}));await wait(()=>!w.document.querySelector('dialog'));assert.equal(calls.filter(c=>c[0]==='action').length,0);
  let complete;w.weborg.pluginAction=async(...args)=>{calls.push(['action',...args]);return new Promise(resolve=>{complete=resolve;});};
  key('Delete',{altKey:true});await wait(()=>find('确认删除'));const confirm=find('确认删除');confirm.click();confirm.click();await wait(()=>complete);
  assert.equal(calls.filter(c=>c[0]==='action').length,1);assert.equal(calls.at(-1)[2],'delete');assert.equal(calls.at(-1)[3].confirmed,true);
  complete({ok:false,reason:'fixture delete failed'});await wait(()=>w.document.querySelector('dialog [role="alert"]'));
  assert.match(w.document.querySelector('dialog').textContent,/fixture delete failed/);find('取消').click();await wait(()=>!w.document.querySelector('dialog'));
  w.weborg.pluginAction=async(...args)=>{calls.push(['action',...args]);return {ok:true};};key('Delete',{altKey:true});await wait(()=>find('确认删除'));find('确认删除').click();await wait(()=>!w.document.querySelector('dialog'));
  const preview=await setup(t,{readonly:true});await preview.scope('clipboard');preview.key('Delete',{altKey:true});await delay(20);assert.equal(preview.w.document.querySelector('dialog'),null);assert.equal(preview.calls.filter(c=>c[0]==='action').length,0);
});
test('native adapter rejects menu/delete without exact confirmation and rejects read-only or invalid targets',async()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../../ui/shared/tauri-adapter.js'),'utf8');
  const calls=[],document={documentElement:{dataset:{}}};
  const ctx=vm.createContext({document,invoke:async(...args)=>calls.push(args),usageListeners:[],window:{confirm(){assert.fail('native confirmation dialog must not be used');}}});
  vm.runInContext(source.slice(source.indexOf('  async function pluginAction('),source.indexOf('  window.weborg =')),ctx);
  for(const action of ['menu','delete'])for(const confirmed of [undefined,false,'true',1])assert.equal((await ctx.pluginAction('clipboard',action,{id:7,confirmed})).ok,false);
  assert.equal(calls.length,0);
  await ctx.pluginAction('clipboard','delete',{id:7,confirmed:true});assert.equal(calls.length,1);assert.equal(calls[0][0],'delete_clipboard');
  document.documentElement.dataset.weborgReadonly='true';assert.equal((await ctx.pluginAction('clipboard','delete',{id:7,confirmed:true})).readonly,true);
  document.documentElement.dataset.weborgReadonly='false';await ctx.pluginAction('clipboard','delete',{id:'invalid',confirmed:true});assert.equal(calls.length,1);
});
