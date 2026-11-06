const {test}=require('node:test'),assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
const key='flowhub.search.queryHistory.v1';
const row=(id,query,scope='app',clipboardKind='all',at=Date.now())=>({id,query,scope,clipboardKind,at});
const panel=s=>s.w.document.querySelector('.query-history-dialog');
const field=s=>s.w.document.querySelector('[aria-label="筛选搜索历史"]');
async function open(s){s.w.document.querySelector('[aria-label="搜索历史与补全"]').click();await wait(()=>field(s) && s.w.document.activeElement===field(s));}
async function filter(s,value){Object.getOwnPropertyDescriptor(s.w.HTMLInputElement.prototype,'value').set.call(field(s),value);field(s).dispatchEvent(new s.w.Event('input',{bubbles:true}));await delay(30);}
const press=(s,key,extra={})=>field(s).dispatchEvent(new s.w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
const button=(s,text)=>[...panel(s).querySelectorAll('button')].find(button=>button.textContent.trim()===text);
const stored=s=>JSON.parse(s.w.localStorage.getItem(key)||'[]');
const actions=s=>s.calls.filter(call=>['copy','action','hide','settings'].includes(call[0]));
async function copy(s){s.w.document.getElementById('resultActionsBtn').click();await wait(()=>s.w.document.querySelector('[data-command-id="result:copy"]'));s.w.document.querySelector('[data-command-id="result:copy"]').click();await wait(()=>!s.w.document.querySelector('.search-actions-dialog'));await delay(30);}

test('query history records explicit result use, deduplicates by conditions and never reads or writes history during typing',async t=>{
  const s=await setup(t);let reads=0,writes=0;
  const get=s.w.Storage.prototype.getItem,set=s.w.Storage.prototype.setItem;
  s.w.Storage.prototype.getItem=function(name){if(name===key)reads++;return get.call(this,name);};
  s.w.Storage.prototype.setItem=function(name,value){if(name===key)writes++;return set.call(this,name,value);};
  await s.scope('app');await s.input('Application');s.w.document.querySelector('.app-result').click();assert.equal(reads,0);assert.equal(writes,0);
  await copy(s);await wait(()=>writes===1);const id=stored(s)[0].id;
  const beforeReads=reads,beforeWrites=writes;await s.input('App');assert.equal(reads,beforeReads);assert.equal(writes,beforeWrites);
  await copy(s);await s.input('Application');await copy(s);assert.equal(stored(s).length,2);assert.equal(stored(s)[0].id,id);
  await open(s);assert.equal(field(s).value,'Application');assert.equal(panel(s).querySelectorAll('[role="option"]').length,1);press(s,'Escape');await wait(()=>!panel(s) && s.w.document.activeElement===s.q);
});

test('history completes a partial query, restores scope/kind and caret, and requires a second confirmation to execute',async t=>{
  const s=await setup(t,{queryHistory:[row('file-query','fixture file','clipboard','file')] ,search:(id,args,fixture)=>id==='clipboard'?[{id:9,kind:'file',fileNames:['fixture.txt']}]:fixture[id]||[]});
  await s.input('fixture');await open(s);assert.equal(field(s).value,'fixture');assert.equal(actions(s).length,0);
  press(s,'Enter');await wait(()=>!panel(s) && s.q.value==='fixture file' && s.w.document.activeElement===s.q && s.w.document.querySelector('[data-scope][aria-pressed="true"]')?.dataset.scope==='clipboard');
  assert.equal(s.w.document.querySelector('[data-scope][aria-pressed="true"]').dataset.scope,'clipboard');
  assert.equal(s.w.document.querySelector('[data-clipboard-kind][aria-pressed="true"]').dataset.clipboardKind,'file');
  assert.equal(s.q.selectionStart,s.q.value.length);assert.equal(s.q.selectionEnd,s.q.value.length);assert.equal(actions(s).length,0);
  await wait(()=>s.w.document.querySelector('.clipboard-result'));s.key('Enter');await wait(()=>s.calls.some(call=>call[0]==='action'));assert.equal(s.calls.find(call=>call[0]==='action')[3].id,9);
});

test('history is searchable from commands, prioritizes prefix completion, and guards IME, navigation and unavailable scopes',async t=>{
  const s=await setup(t,{queryHistory:[row('contains','before Application'),row('prefix','Application fixture','disabled-source','all',1)]});
  await s.input('App');s.w.document.getElementById('commandsBtn').click();await wait(()=>s.w.document.querySelector('[data-command-id="local:history"]'));
  s.w.document.querySelector('[data-command-id="local:history"]').click();await wait(()=>field(s));assert.equal(s.w.document.querySelector('.launcher-commands-dialog'),null);
  assert.equal(panel(s).querySelector('[role="option"]').dataset.commandId,'prefix');assert.match(panel(s).textContent,/原来源停用/);
  field(s).dispatchEvent(new s.w.CompositionEvent('compositionstart',{bubbles:true}));for(const key of ['Enter','Escape','Tab'])press(s,key,{isComposing:true});assert.ok(panel(s));
  field(s).dispatchEvent(new s.w.CompositionEvent('compositionend',{bubbles:true}));press(s,'Enter');assert.ok(panel(s));await delay(90);press(s,'Enter',{metaKey:true});assert.ok(panel(s));
  press(s,'Enter');await wait(()=>!panel(s) && s.q.value==='Application fixture');assert.equal(s.w.document.querySelector('[data-scope][aria-pressed="true"]').dataset.scope,'all');assert.equal(actions(s).length,0);
});

test('remove targets the highlighted query; clearing requires confirmation and does not affect command histories',async t=>{
  const s=await setup(t,{queryHistory:[row('first','First'),row('second','Second','web','all',1)]});
  s.w.FlowHubCommandStore.history.record('ping','ping example.test');await open(s);
  await wait(()=>field(s).getAttribute('aria-activedescendant'));press(s,'ArrowDown');await delay(30);button(s,'移除选中查询').click();await wait(()=>stored(s).length===1);assert.equal(stored(s)[0].id,'first');
  button(s,'清空全部').click();await wait(()=>button(s,'确认清空'));assert.equal(stored(s).length,1);button(s,'取消').click();assert.equal(stored(s).length,1);
  button(s,'清空全部').click();await wait(()=>button(s,'确认清空'));button(s,'确认清空').click();await wait(()=>stored(s).length===0);assert.match(panel(s).textContent,/暂无搜索历史/);
  assert.equal(s.w.FlowHubCommandStore.history.list('ping').length,1);assert.equal(actions(s).length,0);
});

test('history privacy, bounds, malformed storage and unavailable storage remain safe; readonly and paused mode never add queries',async t=>{
  const s=await setup(t),api=s.w.SearchTest;let value='[]';const storage={getItem:()=>value,setItem:(_,next)=>{value=next;}};
  const store=api.createQueryHistory({storage:()=>storage,readonly:()=>false});
  for(const query of ['', 'a'.repeat(257),'line\nsecret','https://user:pass@example.test','curl --user tester','password=hidden','Authorization: bearer secret','https://example.test/?token=secret','eyJhbGciOi.test.signature'])store.record({query,scope:'all',clipboardKind:'all'});
  assert.equal(store.snapshot().length,0);
  for(let index=0;index<105;index++)store.record({query:'Query '+index,scope:'all',clipboardKind:'all'});assert.equal(store.snapshot().length,100);
  value=JSON.stringify([{...row('bad','password=hidden'),path:'/private'},row('good','Safe')]);store.refresh();assert.equal(store.snapshot().length,1);assert.equal(store.snapshot()[0].path,undefined);
  const blocked=api.createQueryHistory({storage:()=>{throw Error('blocked');},readonly:()=>false});blocked.record({query:'Safe',scope:'all',clipboardKind:'all'});assert.equal(blocked.snapshot().length,1);assert.equal(blocked.sessionOnly(),true);blocked.clear();assert.equal(blocked.snapshot().length,0);
  const preview=await setup(t,{readonly:true,queryHistory:[row('old','Application')]});await preview.scope('app');await preview.input('Application');preview.key('Enter');await delay(30);assert.equal(stored(preview).length,1);await open(preview);assert.equal(button(preview,'清空全部'),undefined);
  const paused=await setup(t,{historyEnabled:false,queryHistory:[row('old','Application')]});await paused.scope('app');await paused.input('App');await copy(paused);assert.equal(stored(paused).length,1);await open(paused);assert.match(panel(paused).textContent,/已暂停记录/);
  await s.events.onConfig({core:{},plugins:{tools:{settings:{commandHistory:false}}}});await s.input('ping example.test');s.key('Enter');await delay(30);assert.equal(stored(s).length,0,'disabling tool command history also excludes tool queries from launcher history');
});

test('history shortcut is isolated from edit/delete dialogs and reactivation cancels pending recall',async t=>{
  const s=await setup(t,{queryHistory:[row('old','Application')]});s.key('H',{ctrlKey:true,shiftKey:true,code:'KeyH'});await wait(()=>field(s));
  panel(s).querySelector('[role="option"]').click();s.w.prepareForShow();await delay(50);assert.equal(s.q.value,'');assert.equal(actions(s).length,0);
  await s.scope('clipboard');s.key('Backspace',{altKey:true});await wait(()=>s.w.document.querySelector('[role="dialog"]'));s.key('H',{ctrlKey:true,shiftKey:true,code:'KeyH'});assert.equal(panel(s),null);
});
test('saved configuration pauses and resumes query recording without deleting existing history',async t=>{
  const s=await setup(t);await s.scope('app');await s.input('First');await copy(s);assert.equal(stored(s).length,1);
  await s.events.onConfig({core:{searchHistoryEnabled:false},plugins:{tools:{settings:{}}}});await s.input('Second');await copy(s);assert.equal(stored(s).length,1);
  await s.events.onConfig({core:{searchHistoryEnabled:true},plugins:{tools:{settings:{}}}});await copy(s);assert.equal(stored(s).length,2);
});
test('fast confirmation after recall cannot activate a result from the previous query while the new search is pending',async t=>{
  let finish;
  const s=await setup(t,{queryHistory:[row('new-query','New application','app')],search:(id,args,fixture)=>id==='app' && args.query==='New application'?new Promise(resolve=>{finish=resolve;}):fixture[id]||[]});
  await s.scope('app');assert.ok(s.w.document.querySelector('.app-result'));await open(s);press(s,'Enter');await wait(()=>finish && s.q.value==='New application');
  s.key('Enter');assert.equal(actions(s).length,0);assert.equal(s.w.document.querySelector('.app-result'),null);
  finish([{id:'new-app',title:'New application',path:'/Applications/New.app'}]);await wait(()=>s.w.document.querySelector('.app-result h3')?.textContent==='New application');s.key('Enter');await wait(()=>s.calls.some(call=>call[0]==='action'));
  assert.equal(s.calls.find(call=>call[0]==='action')[3].path,'/Applications/New.app');
});
