const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
const panel=s=>s.w.document.querySelector('.search-actions-dialog');
const field=s=>s.w.document.querySelector('input[aria-label="搜索结果操作"]');
const options=s=>[...s.w.document.querySelectorAll('.search-actions-dialog [role="option"]')];
const press=(s,key,extra={})=>field(s).dispatchEvent(new s.w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
async function filter(s,value){Object.getOwnPropertyDescriptor(s.w.HTMLInputElement.prototype,'value').set.call(field(s),value);field(s).dispatchEvent(new s.w.Event('input',{bubbles:true}));await delay(30);}
async function open(s){s.w.document.getElementById('resultActionsBtn').click();await wait(()=>field(s) && s.w.document.activeElement===field(s));}
function layout(s){s.w.HTMLElement.prototype.getClientRects=function(){return [{top:0,left:0,right:200,bottom:40,width:200,height:40}];};}

test('action panel searches labels and aliases; filtering never executes, keyboard chooses one current action',async t=>{
  const s=await setup(t,{autoPreviewLongContent:false});layout(s);await s.scope('web');await s.input('Website');await open(s);
  assert.match(panel(s).textContent,/Website/);assert.equal(options(s).length,3);
  await filter(s,'copy');assert.equal(options(s).length,1);assert.match(options(s)[0].textContent,/复制链接/);
  assert.equal(s.calls.some(c=>c[0]==='copy'||c[0]==='action'||c[0]==='settings'),false);
  press(s,'Enter');await wait(()=>s.calls.some(c=>c[0]==='copy'));
  assert.equal(s.calls.filter(c=>c[0]==='copy').length,1);assert.equal(s.calls.find(c=>c[0]==='copy')[1],'https://example.com');
  assert.equal(panel(s),null);assert.equal(s.q.value,'Website');assert.equal(s.w.document.querySelector('.result.active h3').textContent,'Website');
  await open(s);assert.equal(field(s).value,'');
  // Wait for the shared autocomplete's initial highlight after modal focus.
  await wait(()=>field(s).getAttribute('aria-activedescendant'));press(s,'ArrowDown');
  await wait(()=>s.w.document.getElementById(field(s).getAttribute('aria-activedescendant'))?.textContent.includes('复制链接'));
  assert.match(s.w.document.getElementById(field(s).getAttribute('aria-activedescendant')).textContent,/复制链接/);
  await filter(s,'不存在的操作');assert.equal(options(s).length,0);assert.match(panel(s).textContent,/没有匹配/);
  press(s,'Enter');assert.equal(s.calls.filter(c=>c[0]==='copy').length,1);
  s.w.document.querySelector('[aria-label="清除操作搜索"]').click();await wait(()=>options(s).length===3);
  press(s,'Escape');await wait(()=>!panel(s) && s.w.document.activeElement===s.q);assert.equal(s.q.value,'Website');
});

test('action panel owns IME, scope keys and Escape; closing exits only the top layer',async t=>{
  const s=await setup(t,{width:390});layout(s);await s.scope('clipboard');s.w.document.querySelector('.clipboard-result').click();await open(s);
  const selected=s.w.document.querySelector('.result.active');
  field(s).dispatchEvent(new s.w.CompositionEvent('compositionstart',{bubbles:true}));
  for(const key of ['Enter','Escape','F6','Tab'])press(s,key,{isComposing:true,keyCode:229});
  assert.ok(panel(s));assert.equal(s.calls.filter(c=>c[0]==='action').length,0);
  field(s).dispatchEvent(new s.w.CompositionEvent('compositionend',{bubbles:true}));press(s,'Enter');
  assert.ok(panel(s),'IME commit must not paste');await delay(90);
  for(const [key,extra] of [['i',{metaKey:true}],['e',{metaKey:true}],['d',{metaKey:true}],['Backspace',{altKey:true}],['Tab',{}],['ArrowDown',{}]])press(s,key,extra);
  assert.equal(s.w.document.querySelector('.result.active'),selected);assert.equal(s.w.document.querySelector('[data-scope][aria-pressed="true"]').dataset.scope,'clipboard');assert.equal(s.calls.filter(c=>c[0]==='action').length,0);
  press(s,'Escape');await wait(()=>!panel(s) && s.w.document.activeElement===s.q);
  assert.equal(s.w.document.querySelector('.search-workbench').dataset.detailOpen,'true');assert.equal(s.calls.some(c=>c[0]==='hide'),false);
  await open(s);press(s,'k',{metaKey:true});await wait(()=>!panel(s) && s.w.document.activeElement===s.q);
  s.key('Escape');await wait(()=>s.w.document.querySelector('.search-workbench').dataset.detailOpen==='false');
});

test('clipboard actions keep captured record across refresh, and deletion still requires separate confirmation',async t=>{
  let records=[{id:1,kind:'text',content:'First'},{id:2,kind:'text',content:'Second'}];
  const s=await setup(t,{search:(id,args,fixture)=>id==='clipboard'?records:fixture[id]||[]});layout(s);await s.scope('clipboard');await open(s);
  await filter(s,'置顶');records=[records[1],records[0]];s.events.onClipboardUpdated();
  await wait(()=>s.w.document.querySelector('.clipboard-result').dataset.id==='2' || s.w.document.querySelector('.clipboard-result h3').textContent==='Second');
  assert.match(panel(s).querySelector('.search-action-target').textContent,/First/);assert.equal(field(s).value,'置顶');
  s.w.document.querySelector('[data-command-id="clipboard:pin"]').click();await wait(()=>s.calls.some(c=>c[0]==='action'));
  assert.equal(s.calls.find(c=>c[0]==='action')[3].id,1);
  await open(s);await filter(s,'delete');s.w.document.querySelector('[data-command-id="clipboard:delete"]').click();
  await wait(()=>s.w.document.querySelector('[role="dialog"] h2')?.textContent==='删除剪贴板记录');
  assert.equal(s.calls.filter(c=>c[0]==='action'&&c[2]==='delete').length,0);
  [...s.w.document.querySelectorAll('[role="dialog"] button')].find(b=>b.textContent==='取消').click();await wait(()=>!s.w.document.querySelector('[role="dialog"]'));
});

test('removed targets and a late read-only change cannot execute stale panel choices',async t=>{
  let records=[{id:1,kind:'text',content:'First'}];
  const s=await setup(t,{search:(id,args,fixture)=>id==='clipboard'?records:fixture[id]||[]});await s.scope('clipboard');await open(s);
  const stale=s.w.document.querySelector('[data-command-id="clipboard:pin"]');records=[];s.events.onClipboardUpdated();
  await wait(()=>!panel(s));stale.click();await delay(40);assert.equal(s.calls.filter(c=>c[0]==='action').length,0);
  records=[{id:2,kind:'image'}];s.events.onClipboardUpdated();await wait(()=>s.w.document.querySelector('.clipboard-result'));await open(s);
  assert.equal(s.w.document.querySelector('[data-command-id="clipboard:plain"]'),null);assert.equal(s.w.document.querySelector('[data-command-id="clipboard:edit"]'),null);
  s.w.document.documentElement.dataset.weborgReadonly='true';s.w.document.querySelector('[data-command-id="clipboard:pin"]').click();await delay(40);assert.equal(s.calls.filter(c=>c[0]==='action').length,0);
});

test('new input or reopening cancels a queued action before the modal is unmounted',async t=>{
  const s=await setup(t,{native:true});await s.scope('web');await open(s);
  s.w.document.querySelector('[data-command-id="result:copy"]').click();s.w.prepareForShow();
  await delay(50);assert.equal(s.calls.filter(c=>c[0]==='copy').length,0);
  await open(s);s.w.document.querySelector('[data-command-id="result:copy"]').click();
  s.q.value='Website';s.q.dispatchEvent(new s.w.Event('input',{bubbles:true}));await delay(50);
  assert.equal(s.calls.filter(c=>c[0]==='copy').length,0);assert.equal(s.q.value,'Website');
});
