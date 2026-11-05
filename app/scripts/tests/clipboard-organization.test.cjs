const {test}=require('node:test'),assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
const match=(rows,args)=>rows.filter(row=>(args.kind==='all'||row.kind===args.kind) && (args.source==null||(row.sourceName||'').trim()===args.source) && (!args.pinnedOnly||row.pinnedAt) && `${row.content||''} ${row.note||''}`.toLowerCase().includes((args.query||'').toLowerCase())).slice(args.offset||0,(args.offset||0)+(args.limit||30)).map(row=>({...row}));
const sourceControl=s=>s.w.document.querySelector('[aria-label="按已保存来源筛选"]');
async function source(s,label){sourceControl(s).click();await wait(()=>s.w.document.querySelector('.clipboard-source-popup [role="option"]'));const option=[...s.w.document.querySelectorAll('.clipboard-source-popup [role="option"]')].find(option=>option.textContent===label);assert.ok(option,label);option.click();await delay(40);}
async function note(s){s.w.document.getElementById('resultActionsBtn').click();await wait(()=>s.w.document.querySelector('[data-command-id="clipboard:note"]'));s.w.document.querySelector('[data-command-id="clipboard:note"]').click();await wait(()=>s.w.document.querySelector('[aria-label="剪贴板备注"]'));}
const editor=s=>s.w.document.querySelector('[aria-label="剪贴板备注"]');
const noteButton=(s,text)=>[...s.w.document.querySelectorAll('.clipboard-note-dialog button')].find(button=>button.textContent===text);
function typeNote(s,value){Object.getOwnPropertyDescriptor(s.w.HTMLTextAreaElement.prototype,'value').set.call(editor(s),value);editor(s).dispatchEvent(new s.w.Event('input',{bubbles:true}));}

test('source, pinned and type filters compose through pagination, do not contaminate all scope, and do not reload source metadata while typing',async t=>{
  const rows=Array.from({length:75},(_,i)=>({id:i+1,kind:i%5===0?'file':'text',content:'record '+i,fileNames:['record.txt'],sourceName:i%3===0?'':'Editor',pinnedAt:i%7===0?'pinned':''}));
  const s=await setup(t,{search:(id,args,fixture)=>id==='clipboard'?match(rows,args):fixture[id]||[]});let reads=0;s.w.weborg.listClipboardSources=async()=>{reads++;return [{name:'Editor',count:50},{name:'',count:25}];};
  await s.scope('clipboard');await wait(()=>reads===1);await source(s,'Editor');assert.equal(s.w.document.querySelectorAll('.clipboard-result').length,30);
  const list=s.w.document.getElementById('results');Object.defineProperties(list,{clientHeight:{configurable:true,value:100},scrollHeight:{configurable:true,value:1000}});list.scrollTop=900;list.dispatchEvent(new s.w.Event('scroll'));
  await wait(()=>s.calls.some(call=>call[0]==='search' && call[1]==='clipboard' && call[2].offset===30 && call[2].source==='Editor'));await wait(()=>s.w.document.querySelectorAll('.clipboard-result').length===50);
  s.w.document.querySelector('[aria-label="只看置顶记录"]').click();await delay(40);assert.equal(s.w.document.querySelectorAll('.clipboard-result').length,7);
  s.w.document.querySelector('[data-clipboard-kind="text"]').click();await delay(30);assert.equal(s.w.document.querySelectorAll('.clipboard-result').length,5);
  await s.input('record');assert.equal(reads,1);await s.scope('all');await wait(()=>s.calls.some(call=>call[0]==='search'&&call[1]==='clipboard'&&call[2].query==='record'&&call[2].source===null&&!call[2].pinnedOnly));
  await s.scope('clipboard');assert.equal(s.w.document.querySelector('[aria-label="只看置顶记录"]').getAttribute('aria-pressed'),'true');
  [...s.w.document.querySelectorAll('#clipboardKindRow button')].find(button=>button.textContent==='重置筛选').click();await delay(30);assert.equal(sourceControl(s).textContent.includes('全部来源'),true);assert.equal(s.q.value,'record');
});

test('notes save against record identity, are searchable, and copy keeps the original clipboard content',async t=>{
  const rows=[{id:1,kind:'text',content:'Original clipboard',note:'',sourceName:'Editor'}];const s=await setup(t,{search:(id,args,fixture)=>id==='clipboard'?match(rows,args):fixture[id]||[]});const saved=[];
  s.w.weborg.setClipboardNote=async(...args)=>{saved.push(args);rows[0].note=args[1].trim();return {ok:true};};await s.scope('clipboard');await note(s);typeNote(s,'Deployment checklist');await delay(10);noteButton(s,'保存备注').click();await wait(()=>!editor(s));await wait(()=>s.w.document.querySelector('.clipboard-result').textContent.includes('Deployment checklist'));
  assert.equal(saved.length,1);assert.equal(saved[0][0],1);assert.equal(saved[0][2],'');assert.equal(rows[0].content,'Original clipboard');
  await s.input('Deployment');await wait(()=>s.w.document.querySelector('.clipboard-result'));s.w.document.getElementById('resultActionsBtn').click();await wait(()=>s.w.document.querySelector('[data-command-id="result:copy"]'));s.w.document.querySelector('[data-command-id="result:copy"]').click();await wait(()=>s.calls.some(call=>call[0]==='copy'));assert.equal(s.calls.find(call=>call[0]==='copy')[1],'Original clipboard');
});

test('note draft survives background reorder, IME and reactivation; failure retains text and pending save cannot duplicate',async t=>{
  let rows=[{id:1,kind:'text',content:'First',note:''},{id:2,kind:'image',note:''}],finish;const s=await setup(t,{search:(id,args,fixture)=>id==='clipboard'?match(rows,args):fixture[id]||[]});const saves=[];s.w.weborg.setClipboardNote=(...args)=>{saves.push(args);return new Promise(resolve=>{finish=resolve;});};
  await s.scope('clipboard');await note(s);typeNote(s,'Unsaved note');await delay(10);editor(s).dispatchEvent(new s.w.CompositionEvent('compositionstart',{bubbles:true}));editor(s).dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Enter',metaKey:true,isComposing:true,bubbles:true,cancelable:true}));assert.equal(saves.length,0);editor(s).dispatchEvent(new s.w.CompositionEvent('compositionend',{bubbles:true}));
  rows=rows.reverse();s.events.onClipboardUpdated();s.w.prepareForShow();await delay(150);assert.equal(editor(s).value,'Unsaved note');assert.equal(s.w.document.activeElement===editor(s),true);
  noteButton(s,'保存备注').click();noteButton(s,'保存备注').click();await wait(()=>finish);assert.equal(saves.length,1);assert.equal(saves[0][0],1);finish({ok:false,reason:'Record changed; reopen'});await wait(()=>s.w.document.querySelector('.clipboard-note-dialog [role="alert"]'));assert.equal(editor(s).value,'Unsaved note');noteButton(s,'取消').click();await wait(()=>!editor(s) && s.w.document.activeElement===s.q);
  assert.equal(s.calls.some(call=>['copy','action','hide'].includes(call[0])),false);
});

test('readonly notes are unavailable, and a late readonly change prevents saves while filters remain usable',async t=>{
  const preview=await setup(t,{readonly:true});await preview.scope('clipboard');preview.w.document.getElementById('resultActionsBtn').click();await wait(()=>preview.w.document.querySelector('[data-command-id="clipboard:note"]'));assert.equal(preview.w.document.querySelector('[data-command-id="clipboard:note"]').getAttribute('aria-disabled'),'true');preview.w.document.querySelector('[data-command-id="clipboard:note"]').click();assert.equal(editor(preview),null);
  const s=await setup(t);let saves=0;s.w.weborg.setClipboardNote=async()=>{saves++;return {ok:true};};await s.scope('clipboard');await note(s);typeNote(s,'note');await delay(10);s.w.document.documentElement.dataset.weborgReadonly='true';noteButton(s,'保存备注').click();await wait(()=>s.w.document.querySelector('.clipboard-note-dialog [role="alert"]'));assert.equal(saves,0);assert.equal(editor(s).value,'note');
});

test('history records and restores source and pinned filters without executing clipboard actions',async t=>{
  const rows=[{id:1,kind:'text',content:'Original',sourceName:'Editor',pinnedAt:'pinned'}];const s=await setup(t,{search:(id,args,fixture)=>id==='clipboard'?match(rows,args):fixture[id]||[]});s.w.weborg.listClipboardSources=async()=>[{name:'Editor',count:1}];await s.scope('clipboard');await source(s,'Editor');s.w.document.querySelector('[aria-label="只看置顶记录"]').click();await s.input('Original');
  s.w.document.getElementById('resultActionsBtn').click();await wait(()=>s.w.document.querySelector('[data-command-id="result:copy"]'));s.w.document.querySelector('[data-command-id="result:copy"]').click();await wait(()=>s.calls.some(call=>call[0]==='copy'));
  [...s.w.document.querySelectorAll('#clipboardKindRow button')].find(button=>button.textContent==='重置筛选').click();s.w.document.querySelector('[aria-label="搜索历史与补全"]').click();await wait(()=>s.w.document.querySelector('.query-history-dialog [role="option"]'));assert.match(s.w.document.querySelector('.query-history-dialog').textContent,/已置顶/);assert.match(s.w.document.querySelector('.query-history-dialog').textContent,/Editor/);s.w.document.querySelector('.query-history-dialog [role="option"]').click();await wait(()=>s.w.document.querySelector('[aria-label="只看置顶记录"]').getAttribute('aria-pressed')==='true');assert.ok(sourceControl(s).textContent.includes('Editor'));assert.equal(s.calls.filter(call=>call[0]==='copy').length,1);assert.equal(s.calls.some(call=>call[0]==='action'),false);
});

test('source metadata failures can retry and old scope replies cannot overwrite a new source list',async t=>{
  const s=await setup(t);let requests=0,stale;s.w.weborg.listClipboardSources=()=>{requests++;if(requests===1)return Promise.reject(Error('offline'));if(requests===2)return new Promise(resolve=>{stale=resolve;});return Promise.resolve([{name:'Fresh source',count:1}]);};await s.scope('clipboard');await wait(()=>s.w.document.querySelector('.clipboard-filter-error'));[...s.w.document.querySelectorAll('button')].find(button=>button.textContent==='重试来源').click();await wait(()=>stale);await s.scope('app');await s.scope('clipboard');await wait(()=>requests===3);stale([{name:'Stale source',count:1}]);sourceControl(s).click();await wait(()=>s.w.document.querySelector('.clipboard-source-popup'));assert.match(s.w.document.querySelector('.clipboard-source-popup').textContent,/Fresh source/);assert.doesNotMatch(s.w.document.querySelector('.clipboard-source-popup').textContent,/Stale source/);
});
