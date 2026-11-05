const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');

test('long clipboard text and commands auto-preview by default without taking focus or persisting a manual choice',async t=>{
  const clips=[{id:1,kind:'text',content:'短文本'},{id:2,kind:'text',content:'长'.repeat(81)},{id:3,kind:'text',content:'第一行\r\n第二行\r\n第三行'},{id:4,kind:'text',content:'短'.repeat(80)},{id:5,kind:'file',content:'文件路径'.repeat(50),fileNames:['fixture.txt']}];
  const {w,q,key,input,scope,calls}=await setup(t,{search:id=>id==='clipboard'?clips:id==='memo'?[{id:'memo',title:'长命令',content:'echo fixture\n'.repeat(10)}]:id==='app'?[{id:'app',title:'长标题'.repeat(40),path:'/Applications/Fixture.app'}]:[]});
  await scope('clipboard');await input('query');q.setSelectionRange(2,2);
  assert.equal(w.document.querySelector('.search-preview'),null);
  key('ArrowDown');await wait(()=>w.document.querySelector('.preview-content')?.textContent===clips[1].content);
  assert.equal(w.document.activeElement,q);assert.equal(q.value,'query');assert.equal(q.selectionStart,2);
  key('ArrowDown');await wait(()=>w.document.querySelector('.preview-content')?.textContent===clips[2].content);
  key('ArrowDown');await wait(()=>!w.document.querySelector('.search-preview'));
  key('ArrowDown');await delay(20);assert.equal(w.document.querySelector('.search-preview'),null,'file content does not trigger text preview');
  await scope('memo');assert.ok(w.document.querySelector('.preview-content'));assert.equal(w.document.activeElement,q);
  await scope('app');assert.equal(w.document.querySelector('.search-preview'),null,'long app names keep the compact layout');
  assert.equal(w.localStorage.length,0);assert.equal(calls.some(call=>call[0]==='action'||call[0]==='copy'),false);
});

test('closing an automatic preview suppresses the current record across refreshes, then another selection re-enables automatic preview',async t=>{
  const clips=[{id:1,kind:'text',content:'A'.repeat(100)},{id:2,kind:'text',content:'B'.repeat(100)}];
  const {w,q,key,input,scope,events}=await setup(t,{search:id=>id==='clipboard'?clips:[]});await scope('clipboard');
  await wait(()=>w.document.querySelector('.preview-content')?.textContent===clips[0].content);
  w.document.querySelector('[aria-label="收起预览"]').click();await wait(()=>!w.document.querySelector('.search-preview'));
  clips[0]={...clips[0],copyCount:2};events.onClipboardUpdated();await delay(120);
  assert.equal(w.document.querySelector('.search-preview'),null);
  await input('same record');assert.equal(w.document.querySelector('.search-preview'),null);
  key('ArrowDown');await wait(()=>w.document.querySelector('.preview-content')?.textContent===clips[1].content);
  assert.equal(w.document.activeElement,q);assert.equal(w.localStorage.getItem('flowhub.search.previewExpanded'),'false');
  key('ArrowUp');await wait(()=>w.document.querySelector('.preview-content')?.textContent===clips[0].content);
  key('i',{metaKey:true,code:'KeyI'});await wait(()=>!w.document.querySelector('.search-preview'));
  assert.equal(w.document.activeElement,q);
  key('i',{metaKey:true,code:'KeyI'});await wait(()=>w.document.querySelector('.search-preview'));
  assert.equal(w.localStorage.getItem('flowhub.search.previewExpanded'),'true');
});

test('automatic preview honors live configuration and narrow layout, while explicit preview remains available',async t=>{
  const {w,q,key,scope,events,resize}=await setup(t,{autoPreviewLongContent:false,search:id=>id==='clipboard'?[{id:1,kind:'text',content:'long '.repeat(30)}]:[]});await scope('clipboard');
  const config=value=>({core:{autoPreviewLongContent:value},plugins:{tools:{settings:{}}}});
  assert.equal(w.document.querySelector('.search-preview'),null);
  await events.onConfig(config(true));await wait(()=>w.document.querySelector('.search-preview'));
  assert.equal(w.document.activeElement,q);assert.equal(w.localStorage.length,0);
  w.document.querySelector('.search-preview-body').focus();
  await events.onConfig(config(false));await wait(()=>!w.document.querySelector('.search-preview'));
  assert.equal(w.document.activeElement,q,'disappearing auto-preview cannot strand keyboard focus');
  key('i',{metaKey:true,code:'KeyI'});await wait(()=>w.document.querySelector('.search-preview'));
  await events.onConfig(config(false));assert.ok(w.document.querySelector('.search-preview'),'explicit expansion overrides automatic behavior');
  await resize(640);await events.onConfig(config(true));assert.equal(w.document.querySelector('.search-preview'),null);
  w.document.querySelector('.result-preview-button').click();await wait(()=>w.document.querySelector('.search-preview'));
  w.document.querySelector('.preview-back').click();await wait(()=>!w.document.querySelector('.search-preview'));
  assert.equal(w.document.activeElement,q);assert.equal(w.localStorage.getItem('flowhub.search.previewExpanded'),'true');
});

test('preview starts collapsed; explicit toggles preserve the query, caret and selected record without execution',async t=>{
  const apps=['A','B'].map(id=>({id,title:`App ${id}`,path:`/Applications/${id}.app`}));
  const {w,q,key,input,scope,calls}=await setup(t,{search:id=>id==='app'?apps:[]});
  await scope('app');await input('App');key('ArrowDown');
  await wait(()=>w.document.querySelector('.app-result.active h3')?.textContent==='App B');
  q.setSelectionRange(1,2);
  const toggle=()=>w.document.querySelector('[aria-keyshortcuts="Meta+I"]');
  assert.equal(w.document.querySelector('.search-preview'),null);
  assert.equal(toggle().getAttribute('aria-expanded'),'false');
  assert.equal(w.localStorage.length,0);
  toggle().click();await wait(()=>w.document.activeElement.matches('.search-preview-body'));
  assert.equal(toggle().getAttribute('aria-controls'),'search-preview');
  assert.equal(w.document.querySelector('.preview-identity h2').textContent,'App B');
  toggle().click();await wait(()=>!w.document.querySelector('.search-preview'));
  assert.equal(w.document.activeElement,q);assert.equal(q.value,'App');
  assert.deepEqual([q.selectionStart,q.selectionEnd],[1,2]);
  assert.equal(w.document.querySelector('.app-result.active h3').textContent,'App B');
  assert.equal(w.localStorage.getItem('flowhub.search.previewExpanded'),'false');
  key('i',{metaKey:true,code:'KeyI'});await wait(()=>w.document.querySelector('.search-preview'));
  key('i',{metaKey:true,code:'KeyI',repeat:true});await delay(25);
  assert.ok(w.document.querySelector('.search-preview'),'holding the shortcut does not repeatedly toggle');
  key('i',{metaKey:true,code:'KeyI'});await wait(()=>!w.document.querySelector('.search-preview'));
  key('F6');assert.ok(w.document.activeElement.matches('.search-clear'));
  key('F6');assert.equal(w.document.activeElement.id,'activateResultBtn','collapsed preview actions are outside the focus cycle');
  assert.equal(calls.some(call=>call[0]==='action'||call[0]==='copy'),false);
});

test('wide preview preference survives input, scopes, reopening and remounting, including temporary tool results',async t=>{
  const {w,q,key,input,scope,unmount,remount}=await setup(t,{autoPreviewLongContent:false});
  key('i',{metaKey:true,code:'KeyI'});await wait(()=>w.document.querySelector('.search-preview'));
  assert.equal(w.localStorage.getItem('flowhub.search.previewExpanded'),'true');
  await scope('app');await input('Application');assert.ok(w.document.querySelector('.search-preview'));
  w.prepareForShow();await wait(()=>q.value===''&&w.document.querySelector('.search-preview'));
  assert.equal(w.document.activeElement,q);
  await scope('all');await input('1+2');
  assert.equal(w.document.querySelector('.search-preview'),null);
  assert.equal(w.document.querySelector('[aria-keyshortcuts="Meta+I"]'),null);
  assert.equal(w.localStorage.getItem('flowhub.search.previewExpanded'),'true');
  await input('Application');assert.ok(w.document.querySelector('.search-preview'));
  unmount();const dispose=remount();t.after(dispose);
  await wait(()=>w.document.querySelector('.search-preview'));
  w.document.querySelector('[aria-label="收起预览"]').click();await wait(()=>!w.document.querySelector('.search-preview'));
  dispose();const disposeAgain=remount();t.after(disposeAgain);
  await wait(()=>w.document.querySelectorAll('[data-scope]').length===6);
  assert.equal(w.document.querySelector('.search-preview'),null);
});

test('narrow detail navigation and resizing preserve the wide preference and never leave focus on a hidden preview',async t=>{
  const {w,q,input,scope,resize}=await setup(t,{previewExpanded:true,width:860});
  await scope('app');await input('Application');q.setSelectionRange(2,2);
  w.document.querySelector('.search-preview-body').focus();
  await resize(640);
  assert.equal(w.document.querySelector('.search-preview'),null);
  assert.equal(w.document.activeElement,q);
  assert.equal(w.localStorage.getItem('flowhub.search.previewExpanded'),'true');
  w.document.querySelector('.result-preview-button').click();await wait(()=>w.document.activeElement.matches('.search-preview-body'));
  w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  await wait(()=>!w.document.querySelector('.search-preview'));
  assert.equal(w.document.activeElement,q);assert.equal(q.value,'Application');
  assert.deepEqual([q.selectionStart,q.selectionEnd],[2,2]);
  await resize(860);assert.ok(w.document.querySelector('.search-preview'));
  w.document.querySelector('[aria-label="收起预览"]').click();await wait(()=>!w.document.querySelector('.search-preview'));
  await resize(640);w.document.querySelector('.result-preview-button').click();
  await wait(()=>w.document.activeElement.matches('.search-preview-body'));
  await resize(860);
  assert.equal(w.document.querySelector('.search-preview'),null);
  assert.equal(w.document.activeElement,q);
  assert.equal(w.localStorage.getItem('flowhub.search.previewExpanded'),'false');
  assert.equal(q.value,'Application');
});

test('read-only preview layout changes stay in memory and do not persist across remounts',async t=>{
  const {w,key,unmount,remount}=await setup(t,{readonly:true,autoPreviewLongContent:false});
  key('i',{metaKey:true,code:'KeyI'});await wait(()=>w.document.querySelector('.search-preview'));
  assert.equal(w.localStorage.length,0);
  unmount();const dispose=remount();t.after(dispose);
  await wait(()=>w.document.querySelectorAll('[data-scope]').length===6);
  assert.equal(w.document.querySelector('.search-preview'),null);
  assert.equal(w.localStorage.length,0);
});

test('unavailable presentation storage cannot prevent mounting or toggling the preview',async t=>{
  const {w,unmount,remount}=await setup(t,{autoPreviewLongContent:false});
  w.Storage.prototype.getItem=()=>{throw Error('storage unavailable');};
  w.Storage.prototype.setItem=()=>{throw Error('storage unavailable');};
  unmount();const dispose=remount();t.after(dispose);
  await wait(()=>w.document.querySelectorAll('[data-scope]').length===6);
  assert.equal(w.document.querySelector('.search-preview'),null);
  w.document.querySelector('[aria-label="展开预览"]').click();await wait(()=>w.document.querySelector('.search-preview'));
  w.document.querySelector('[aria-label="收起预览"]').click();await wait(()=>!w.document.querySelector('.search-preview'));
});

test('mixed results identify their source without repeating it in a dedicated scope',async t=>{
  const {w,scope}=await setup(t);
  for(const [selector,label] of [['.app-result','应用'],['.page-result','网页'],['.clipboard-result','剪贴板'],['.memo-result','命令']]) {
    assert.equal(w.document.querySelector(`${selector} .result-kind`).textContent,label);
  }
  await scope('app');assert.equal(w.document.querySelector('.result-kind'),null);
});

test('literal query highlighting updates retained rows, preserves content and stays bounded',async t=>{
  const title='Application [.*] <script> safe AAA aaa '+('a'.repeat(90));
  const {w,scope,input}=await setup(t,{search:(id,args,fixture)=>id==='app'?[{id:'fixed',title,path:'/Applications/[.*] Test.app'}]:fixture[id]||[]});
  await scope('app');await input('[.*]');const row=w.document.querySelector('.app-result');
  assert.equal(row.querySelector('h3 mark').textContent,'[.*]');assert.equal(row.querySelector('.search-meta mark').textContent,'[.*]');
  await input('aaa safe');assert.ok(w.document.querySelector('.app-result')===row);assert.equal(row.querySelector('h3').textContent,title);
  assert.deepEqual([...row.querySelectorAll('h3 mark')].slice(0,3).map(el=>el.textContent),['safe','AAA','aaa']);
  assert.equal(row.querySelector('script'),null);
  await input('a');assert.ok(row.querySelectorAll('h3 mark').length<=8);
  await input('');assert.equal(w.document.querySelector('.app-result mark'),null);assert.equal(w.document.querySelector('.app-result h3').textContent,title);
});

test('empty search recovery keeps the query when searching all and focuses input when clearing',async t=>{
  const {w,q,scope,input,calls}=await setup(t,{search:(id,args)=>id==='clipboard'&&args.query==='kept'?[{id:1,kind:'text',content:'kept text'}]:[]});
  await scope('app');await input('kept');
  const buttons=()=>[...w.document.querySelectorAll('.search-recovery button')];
  assert.equal(buttons().length,2);assert.ok(w.document.querySelector('[data-slot="empty"]'));
  buttons().find(button=>button.textContent==='搜索全部范围').click();
  await wait(()=>w.document.querySelector('.clipboard-result'));
  assert.equal(q.value,'kept');assert.equal(w.document.activeElement,q);
  assert.equal(w.document.querySelector('[data-scope="all"]').getAttribute('aria-pressed'),'true');
  await scope('app');await input('missing');buttons().find(button=>button.textContent==='清除搜索').click();
  await wait(()=>q.value==='');assert.equal(w.document.activeElement,q);
  assert.equal(w.document.querySelector('[data-scope="app"]').getAttribute('aria-pressed'),'true');
  assert.equal(calls.filter(call=>call[0]==='action').length,0);
});

test('F6 includes empty-state recovery actions and returns to search after the final action',async t=>{
  const {w,q,key,input,scope}=await setup(t,{search:()=>[]});await scope('app');await input('missing');
  key('F6');assert.ok(w.document.activeElement.matches('.search-clear'));
  const advance=()=>w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'F6',bubbles:true,cancelable:true}));
  advance();assert.equal(w.document.activeElement.textContent,'清除搜索');
  advance();assert.equal(w.document.activeElement.textContent,'搜索全部范围');
  advance();assert.equal(w.document.activeElement,q);
});

test('preview Option arrows preserve the query, stop at list boundaries and never execute results',async t=>{
  const apps=Array.from({length:3},(_,i)=>({id:String(i),title:`App ${i}`,path:`/Applications/App${i}.app`}));
  const {w,q,scope,input,key,calls}=await setup(t,{search:(id,args,fixture)=>id==='app'?apps:fixture[id]||[]});
  await scope('app');await input('App');q.setSelectionRange(1,1);
  Object.defineProperty(w.document,'hasFocus',{configurable:true,value:()=>true});
  key('i',{metaKey:true,code:'KeyI'});
  await wait(()=>w.document.activeElement.matches('.search-preview-body'));
  const navigate=key=>w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key,altKey:true,bubbles:true,cancelable:true}));
  navigate('ArrowUp');await delay(10);assert.equal(w.document.querySelector('.app-result.active h3').textContent,'App 0');
  navigate('ArrowDown');await wait(()=>w.document.querySelector('.app-result.active h3').textContent==='App 1');
  assert.equal(q.value,'App');assert.equal(q.selectionStart,1);
  navigate('ArrowUp');
  await wait(()=>w.document.querySelector('.app-result.active h3').textContent==='App 0');
  navigate('ArrowDown');await wait(()=>w.document.querySelector('.app-result.active h3').textContent==='App 1');
  navigate('ArrowDown');await wait(()=>w.document.querySelector('.app-result.active h3').textContent==='App 2');
  navigate('ArrowDown');await delay(10);assert.equal(w.document.querySelector('.app-result.active h3').textContent,'App 2');
  assert.equal(calls.filter(call=>call[0]==='action').length,0);
  q.focus();assert.equal(key('ArrowUp',{altKey:true}),false,'existing query navigation remains handled by the controller');
});

test('keyboard preview navigation reveals the active option in a virtualized list',async t=>{
  const {w,key,scope,calls}=await setup(t,{search:(id,args,fixture)=>id==='app'?Array.from({length:120},(_,i)=>({id:String(i),title:`App ${i}`,path:`/Applications/${i}.app`})):fixture[id]||[]});
  await scope('app');
  for(let i=0;i<25;i++){key('ArrowDown');await delay(3);}
  await wait(()=>w.document.querySelector('.app-result.active')?.dataset.i==='25');
  key('i',{metaKey:true,code:'KeyI'});
  await wait(()=>w.document.activeElement.matches('.search-preview-body'));
  w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true,cancelable:true}));
  await wait(()=>w.document.querySelector('.app-result.active')?.dataset.i==='26');
  assert.equal(w.document.querySelector('#q').getAttribute('aria-activedescendant'),'search-result-26');
  assert.ok(w.document.querySelectorAll('.result').length<80);assert.equal(calls.filter(call=>call[0]==='action').length,0);
});
