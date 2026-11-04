const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');

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

test('preview navigation and Option arrows preserve the query and never execute results',async t=>{
  const apps=Array.from({length:3},(_,i)=>({id:String(i),title:`App ${i}`,path:`/Applications/App${i}.app`}));
  const {w,q,scope,input,key,calls}=await setup(t,{search:(id,args,fixture)=>id==='app'?apps:fixture[id]||[]});
  await scope('app');await input('App');q.setSelectionRange(1,1);
  Object.defineProperty(w.document,'hasFocus',{configurable:true,value:()=>true});
  const previous=()=>w.document.querySelector('[aria-label="上一个结果"]'),next=()=>w.document.querySelector('[aria-label="下一个结果"]');
  assert.equal(previous().disabled,true);next().click();await wait(()=>w.document.querySelector('.app-result.active h3').textContent==='App 1');
  await wait(()=>w.document.activeElement.matches('.search-preview-body'));
  assert.equal(q.value,'App');assert.equal(q.selectionStart,1);
  w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true,cancelable:true}));
  await wait(()=>w.document.querySelector('.app-result.active h3').textContent==='App 0');
  next().click();await delay(10);next().click();await wait(()=>next().disabled);
  assert.equal(w.document.querySelector('.preview-position').textContent,'3 / 3');
  assert.equal(calls.filter(call=>call[0]==='action').length,0);
  q.focus();assert.equal(key('ArrowUp',{altKey:true}),false,'existing query navigation remains handled by the controller');
});

test('explicit preview navigation reveals the active option in a virtualized list',async t=>{
  const {w,key,scope,calls}=await setup(t,{search:(id,args,fixture)=>id==='app'?Array.from({length:120},(_,i)=>({id:String(i),title:`App ${i}`,path:`/Applications/${i}.app`})):fixture[id]||[]});
  await scope('app');
  for(let i=0;i<25;i++){key('ArrowDown');await delay(3);}
  await wait(()=>w.document.querySelector('.app-result.active')?.dataset.i==='25');
  w.document.querySelector('[aria-label="下一个结果"]').click();
  await wait(()=>w.document.querySelector('.app-result.active')?.dataset.i==='26');
  assert.equal(w.document.querySelector('#q').getAttribute('aria-activedescendant'),'search-result-26');
  assert.ok(w.document.querySelectorAll('.result').length<80);assert.equal(calls.filter(call=>call[0]==='action').length,0);
});
