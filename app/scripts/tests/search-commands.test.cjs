const {test}=require('node:test'),assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
const dialog=s=>s.w.document.querySelector('.launcher-commands-dialog');
const input=s=>s.w.document.querySelector('[aria-label="搜索 FlowHub 命令"]');
async function open(s){s.w.document.getElementById('commandsBtn').click();await wait(()=>input(s) && s.w.document.activeElement===input(s));}
async function filter(s,value){Object.getOwnPropertyDescriptor(s.w.HTMLInputElement.prototype,'value').set.call(input(s),value);input(s).dispatchEvent(new s.w.Event('input',{bubbles:true}));await delay(30);}
const press=(s,key,extra={})=>input(s).dispatchEvent(new s.w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
const choose=(s,id)=>s.w.document.querySelector(`[data-command-id="${id}"]`).click();
const actions=s=>s.calls.filter(c=>['action','copy','settings','hide'].includes(c[0]));

test('command palette searches host pages and aliases without executing, and opens the exact settings destination once',async t=>{
  const s=await setup(t);await s.scope('web');await s.input('Website');await open(s);
  await filter(s,'主题');assert.ok(s.w.document.querySelector('[data-command-id="settings:appearance"]'));assert.equal(actions(s).length,0);
  await filter(s,'not-a-command');assert.match(dialog(s).textContent,/没有匹配命令/);press(s,'Enter');assert.equal(actions(s).length,0);
  await filter(s,'hotkey');assert.ok(s.w.document.querySelector('[data-command-id="settings:core"]'));
  await filter(s,'主题');choose(s,'settings:appearance');await wait(()=>!dialog(s) && s.w.document.activeElement===s.q);
  assert.equal(s.calls.find(c=>c[0]==='settings')[1].initialModule,'appearance');assert.equal(s.q.value,'Website');
  await open(s);assert.equal(input(s).value,'');choose(s,'settings:extensions');await wait(()=>!dialog(s));
  assert.equal(s.calls.filter(c=>c[0]==='settings').length,2);assert.equal(s.calls.filter(c=>c[0]==='action').length,0);
});

test('plugin catalog is lazy, failure can retry, names are escaped, and rejected opens preserve the palette for retry',async t=>{
  const s=await setup(t);let lists=0,opens=0;
  s.w.weborg.listLauncherPlugins=async()=>{lists++;if(lists===1)throw Error('fixture catalog offline');return [{id:'example',name:'<script>插件</script>',description:'验证插件'}];};
  s.w.weborg.openSettings=async options=>{opens++;s.calls.push(['settings',options]);return opens===1?{ok:false,reason:'插件已停用'}:{ok:true};};
  assert.equal(lists,0);await open(s);await wait(()=>dialog(s).textContent.includes('fixture catalog offline'));
  [...dialog(s).querySelectorAll('button')].find(b=>b.textContent==='重试').click();await wait(()=>s.w.document.querySelector('[data-command-id="plugin:example"]'));
  await filter(s,'example');assert.equal(dialog(s).querySelector('script'),null);assert.match(dialog(s).textContent,/<script>插件/);choose(s,'plugin:example');
  await wait(()=>dialog(s)?.textContent.includes('插件已停用'));assert.equal(input(s).value,'example');assert.equal(opens,1);
  choose(s,'plugin:example');await wait(()=>!dialog(s));assert.equal(opens,2);assert.equal(s.calls.at(-1)[1].initialModule,'plugin:example');
});

test('local commands change scope, preview and clear explicitly while preserving the query until clear is chosen',async t=>{
  const s=await setup(t,{autoPreviewLongContent:false});await s.input('fixture');await open(s);choose(s,'scope:memo');await wait(()=>!dialog(s) && s.w.document.activeElement===s.q);
  assert.equal(s.q.value,'fixture');assert.equal(s.w.document.querySelector('[data-scope][aria-pressed="true"]').dataset.scope,'memo');
  await delay(60);assert.equal(s.w.document.activeElement===s.q,true,'the dialog trigger must not reclaim focus after scope navigation');
  await open(s);choose(s,'local:preview');await wait(()=>!dialog(s) && s.w.document.querySelector('.search-preview') && s.w.document.activeElement===s.q);
  await open(s);choose(s,'local:clear');await wait(()=>!dialog(s) && s.q.value==='');assert.equal(actions(s).length,0);
  let pins=0;s.w.weborg.setLauncherPinned=async value=>{pins++;return value;};await open(s);choose(s,'local:pin');await wait(()=>!dialog(s));assert.equal(pins,1);
  assert.equal(s.w.document.getElementById('pinBtn').getAttribute('aria-pressed'),'true');
});

test('command shortcut respects platform, IME and higher priority dialogs; command keyboard does not leak to launcher',async t=>{
  const s=await setup(t);Object.defineProperty(s.w.navigator,'platform',{configurable:true,value:'MacIntel'});
  for(const extra of [{ctrlKey:true,shiftKey:true},{metaKey:true,shiftKey:true,isComposing:true},{metaKey:true,shiftKey:true,repeat:true}])s.key('P',{code:'KeyP',...extra});
  assert.equal(dialog(s),null);s.key('P',{code:'KeyP',metaKey:true,shiftKey:true});await wait(()=>input(s));
  input(s).dispatchEvent(new s.w.CompositionEvent('compositionstart',{bubbles:true}));press(s,'Enter',{isComposing:true});press(s,'Escape',{keyCode:229});assert.ok(dialog(s));assert.equal(actions(s).length,0);
  input(s).dispatchEvent(new s.w.CompositionEvent('compositionend',{bubbles:true}));press(s,'Enter');assert.equal(actions(s).length,0);await delay(90);
  const scope=s.w.document.querySelector('[data-scope][aria-pressed="true"]').dataset.scope;press(s,'Tab');press(s,'i',{metaKey:true});press(s,'d',{metaKey:true});
  assert.equal(s.w.document.querySelector('[data-scope][aria-pressed="true"]').dataset.scope,scope);
  press(s,'Escape');await wait(()=>!dialog(s) && s.w.document.activeElement===s.q);assert.equal(actions(s).length,0);
  await s.scope('clipboard');s.key('Backspace',{altKey:true});await wait(()=>s.w.document.querySelector('[role="dialog"]'));s.key('P',{metaKey:true,shiftKey:true,code:'KeyP'});assert.equal(dialog(s),null);
});

test('read-only commands allow navigation and layout without writes; stale catalog replies cannot reopen a dismissed palette',async t=>{
  const s=await setup(t,{readonly:true});s.key('P',{ctrlKey:true,shiftKey:true,code:'KeyP'});await wait(()=>input(s));assert.equal(s.w.document.querySelector('[data-command-id="local:pin"]').getAttribute('aria-disabled'),'true');
  choose(s,'local:pin');assert.ok(dialog(s));choose(s,'scope:clipboard');await wait(()=>!dialog(s));assert.equal(actions(s).length,0);
  let resolve;s.w.weborg.listLauncherPlugins=()=>new Promise(done=>{resolve=done;});await open(s);await wait(()=>resolve);press(s,'Escape');await wait(()=>!dialog(s));
  resolve([{id:'late',name:'Late plugin'}]);await delay(30);assert.equal(dialog(s),null);assert.equal(s.w.document.activeElement===s.q,true);
});
