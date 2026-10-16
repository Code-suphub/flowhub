const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
const appItem=title=>({type:'app',title,path:`/Applications/${title}.app`});
test('keyboard result selection ignores stationary pointer events after reflow and resumes on real movement',async t=>{
  const clips=[1,2,3].map(id=>({id,kind:'text',content:`clipboard ${id}\n`+'long line\n'.repeat(10)}));
  const {w,q,key,scope,calls}=await setup(t,{native:true,search:(id,args,fixture)=>id==='clipboard'?clips:fixture[id]||[]});await scope('clipboard');q.focus();
  const row=index=>w.document.querySelector(`.result[data-i="${index}"]`),active=()=>Number(w.document.querySelector('.result.active').dataset.i),root=w.document.querySelector('.search-shell');
  const move=(index,x,y)=>row(index).dispatchEvent(new w.MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y}));
  move(0,50,150);key('ArrowDown');await wait(()=>active()===1);
  move(0,50,150);assert.equal(active(),1);assert.equal(root.dataset.resultInput,'keyboard');
  w.document.getElementById('results').dispatchEvent(new w.Event('scroll'));await delay(20);move(0,50,150);assert.equal(active(),1,'scroll and reflow cannot revive the old hovered row');
  q.dispatchEvent(new w.MouseEvent('mousemove',{bubbles:true,clientX:80,clientY:40}));
  key('ArrowDown');await wait(()=>active()===2);
  move(0,80,40);assert.equal(active(),2,'a row reflowing under a pointer last seen outside the list cannot steal keyboard selection');
  move(2,81,40);await wait(()=>active()===2);assert.equal(root.dataset.resultInput,'pointer');
  key('ArrowUp');await wait(()=>active()===1);move(2,81,40);assert.equal(active(),1);assert.equal(root.dataset.resultInput,'keyboard');
  row(0).dispatchEvent(new w.MouseEvent('mousedown',{button:0,bubbles:true,clientX:51,clientY:150}));row(0).click();
  await wait(()=>calls.some(call=>call[0]==='action'&&call[3].id===1));assert.equal(root.dataset.resultInput,'pointer','explicit click remains available at stationary coordinates');
  w.prepareForShow();await wait(()=>active()===0);key('ArrowDown');await wait(()=>active()===1);
  move(0,80,100);assert.equal(active(),1,'first position after reopen only establishes a new baseline');
  move(0,80,100);assert.equal(active(),1);move(0,81,100);await wait(()=>active()===0);
});
test('unknown pointer events cannot undo shortcut navigation or overwrite its preferred column',async t=>{
  const {w,key,scope,input}=await setup(t,{usage:{frequent:['A','B','C'].map(appItem),recent:['D','E'].map(appItem)}});
  const active=()=>w.document.querySelector('.result.active h3')?.textContent;
  const move=(title,x)=>[...w.document.querySelectorAll('.usage-tile')].find(row=>row.querySelector('h3').textContent===title).dispatchEvent(new w.MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:100}));
  key('ArrowRight');await wait(()=>active()==='B');move('A',50);assert.equal(active(),'B','unknown first pointer event does not undo Right');
  key('ArrowDown');await wait(()=>active()==='E');move('A',50);assert.equal(active(),'E');key('ArrowUp');await wait(()=>active()==='B');
  key('ArrowLeft');await wait(()=>active()==='A');move('C',50);assert.equal(active(),'A');move('C',51);await wait(()=>active()==='C');
  key('ArrowDown');await wait(()=>active()==='E');key('ArrowUp');await wait(()=>active()==='C','real movement updates the preferred usage column');
  await scope('app');key('ArrowRight');await wait(()=>active()==='B');move('A',51);assert.equal(active(),'B','scope reordering does not revive stationary hover');
  await input('query');await input('');key('ArrowRight');await wait(()=>active()==='B');move('A',51);assert.equal(active(),'B','query rerender does not revive stationary hover');
});
test('empty-input usage horizontal navigation stays in its row and updates vertical preference in every source scope',async t=>{
  for(const id of ['all','app','web']) {
    const item=title=>id==='web'?{type:'page',id:title,title,url:`https://example.com/${title}`} : appItem(title);
    const {w,key,scope,calls}=await setup(t,{usage:{frequent:['A','B','C'].map(item),recent:['D','E'].map(item)}});await scope(id);
    const active=()=>w.document.querySelector('.result.active h3')?.textContent;
    assert.match(w.document.getElementById('keyboardHint').textContent,/↑↓ 跨排 · ←→ 同排/);
    assert.equal(key('ArrowLeft'),false);assert.equal(active(),'A');
    key('ArrowRight');await wait(()=>active()==='B');key('ArrowRight');await wait(()=>active()==='C');
    assert.equal(key('ArrowRight'),false);assert.equal(active(),'C','right boundary does not enter the next row');
    key('ArrowDown');await wait(()=>active()==='E');key('ArrowUp');await wait(()=>active()==='C');
    key('ArrowLeft');await wait(()=>active()==='B');key('ArrowDown');await wait(()=>active()==='E');
    key('ArrowLeft');await wait(()=>active()==='D');key('ArrowUp');await wait(()=>active()==='A');
    key('Enter');await wait(()=>calls.some(call=>call[0]==='action'&&(call[3].id==='A'||call[3].path==='/Applications/A.app')));
  }
});
test('usage horizontal keys preserve text, spaces, pending input, modifiers, IME, ordinary results and button focus',async t=>{
  const {w,q,key,input}=await setup(t,{usage:{frequent:['A','B'].map(appItem),recent:[appItem('D')]}});
  const active=()=>w.document.querySelector('.result.active h3')?.textContent;
  for(const value of ['text',' ']) {q.value=value;q.setSelectionRange(1,1);assert.equal(key('ArrowRight'),true);assert.equal(key('ArrowLeft'),true);assert.equal(active(),'A');assert.equal(q.selectionStart,1);}
  q.value='';
  for(const modifier of ['metaKey','ctrlKey','altKey','shiftKey']) {assert.equal(key('ArrowRight',{[modifier]:true}),true);assert.equal(active(),'A');}
  for(const extra of [{isComposing:true},{keyCode:229}]) {assert.equal(key('ArrowRight',extra),true);assert.equal(active(),'A');}
  assert.equal(key('Process'),true);
  q.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));assert.equal(key('ArrowRight'),true);q.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));
  await input(' ');assert.doesNotMatch(w.document.getElementById('keyboardHint').textContent,/←→ 同排/);q.value='';assert.equal(key('ArrowRight'),true,'pending state.query is not empty even after DOM text was cleared');assert.equal(active(),'A');
  await input('');
  const button=w.document.getElementById('settingsBtn');button.focus();assert.equal(button.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})),true);assert.equal(active(),'A');
  q.focus();key('ArrowDown');await wait(()=>active()==='D');key('ArrowDown');await wait(()=>!w.document.querySelector('.result.active').classList.contains('usage-tile'));
  assert.equal(key('ArrowRight'),true);assert.equal(key('ArrowLeft'),true);
});
test('usage arrows move between rows at the preferred column and preserve input arrows, Enter, modifiers and IME',async t=>{
  const {w,q,key,scope,calls,input}=await setup(t,{usage:{frequent:['A','B','C'].map(appItem),recent:['D','E'].map(appItem)}});
  const active=()=>w.document.querySelector('.result.active h3')?.textContent;
  for(const id of ['all','app']) {
    await scope(id);assert.equal(active(),'A');
    w.document.querySelector('.usage-tile.active').dispatchEvent(new w.MouseEvent('mousemove',{bubbles:true,clientX:0,clientY:0}));
    assert.deepEqual([...w.document.querySelectorAll('.search-usage-label')].map(node=>node.textContent),['常用','最近']);
    assert.equal(key('ArrowRight'),false);await wait(()=>active()==='B');assert.equal(key('ArrowLeft'),false);await wait(()=>active()==='A');
    key('ArrowUp');assert.equal(active(),'A','first usage row is an upper boundary');
    key('ArrowDown');await wait(()=>active()==='D');
    key('ArrowUp');await wait(()=>active()==='A');
    [...w.document.querySelectorAll('.usage-tile')].find(row=>row.querySelector('h3').textContent==='C').dispatchEvent(new w.MouseEvent('mousemove',{bubbles:true,clientX:80,clientY:50}));
    await wait(()=>active()==='C');
    key('ArrowDown');await wait(()=>active()==='E');key('Enter');await wait(()=>calls.some(c=>c[0]==='action'&&c[3].path==='/Applications/E.app'));
    key('ArrowUp');await wait(()=>active()==='C','clamping the shorter row preserves the original column');
    key('ArrowDown');await wait(()=>active()==='E');
    key('ArrowDown');await wait(()=>!w.document.querySelector('.result.active').classList.contains('usage-tile'));
    key('ArrowUp');await wait(()=>active()==='E');key('ArrowUp');await wait(()=>active()==='C');
    assert.ok([...w.document.querySelectorAll('.usage-tile h3')].some(node=>node.textContent==='D'));
    key('Enter');await wait(()=>calls.some(c=>c[0]==='action'&&c[3].path==='/Applications/C.app'));
    key('ArrowDown');await wait(()=>active()==='E');
    w.document.querySelector('.usage-tile.active').dispatchEvent(new w.MouseEvent('mousemove',{bubbles:true,clientX:90,clientY:100}));
    key('ArrowUp');await wait(()=>active()==='B','mouse selection replaces the preferred column even on the selected tile');
  }
  for(const modifier of ['metaKey','ctrlKey','altKey','shiftKey']) {
    assert.equal(key('ArrowRight',{[modifier]:true}),true);assert.equal(active(),'B');
  }
  q.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));const before=calls.length;
  key('Enter');assert.equal(calls.length,before);q.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));
  await input('search');await scope('app');q.setSelectionRange(3,3);assert.equal(key('ArrowRight'),true,'bare arrows in normal result rows belong to input');assert.equal(key('ArrowLeft'),true);assert.equal(q.selectionStart,3);
  for(const [action,message] of [
    [async()=>({ok:false,reason:'应用路径为空'}),'应用路径为空'],
    [async()=>{throw 'Launch Services refused';},'Launch Services refused'],
    [()=>{throw new Error('native bridge failed');},'native bridge failed']
  ]) {w.weborg.pluginAction=action;key('Enter');await wait(()=>w.document.getElementById('actionStatus').textContent===message);}
  const previous=w.document.getElementById('actionStatus').textContent;
  w.weborg.pluginAction=async()=>({ok:false,cancelled:true});key('Enter');await delay(20);assert.equal(w.document.getElementById('actionStatus').textContent,previous);
  const web=await setup(t,{usage:{frequent:['A','B','C'].map(title=>({...appItem(title),type:'page',id:title,url:'https://example.com'})),recent:['D','E'].map(title=>({...appItem(title),type:'page',id:title,url:'https://example.com'}))}});
  await web.scope('web');assert.equal(web.key('ArrowRight'),false);await wait(()=>web.w.document.querySelector('.result.active h3')?.textContent==='B');web.key('ArrowLeft');await wait(()=>web.w.document.querySelector('.result.active h3')?.textContent==='A');web.key('ArrowDown');await wait(()=>web.w.document.querySelector('.result.active h3')?.textContent==='D');
  web.key('Enter');await wait(()=>web.calls.some(c=>c[0]==='action'&&c[1]==='web'&&c[3].id==='D'));
});

test('both usage rows filter by source and keep recent entries when frequent is empty',async t=>{
  const {w,q,key,scope,calls}=await setup(t,{usage:{frequent:[appItem('A')],recent:[appItem('D'),{type:'page',id:'recent-web',title:'Recent website',url:'https://example.com'}]}});
  assert.equal(w.document.querySelectorAll('[data-usage-section]').length,0);
  key('ArrowDown');
  await wait(()=>w.document.querySelector('.result.active h3')?.textContent==='D');
  key('Enter');await wait(()=>calls.some(c=>c[0]==='action'&&c[3].path==='/Applications/D.app'));
  await scope('web');await wait(()=>w.document.querySelector('.usage-tile h3')?.textContent==='Recent website');
  assert.ok(w.document.querySelector('#results').textContent.includes('暂无常用入口'));
  assert.equal(w.document.querySelectorAll('.usage-tile').length,1);
  assert.ok(!w.document.querySelector('[data-group="usage:frequent"] .usage-tile'));
  q.focus();key('Enter');await wait(()=>calls.some(c=>c[0]==='action'&&c[3].id==='recent-web'));
  key('ArrowUp');assert.equal(w.document.querySelector('.usage-tile.active h3')?.textContent,'Recent website');
  key('ArrowDown');await wait(()=>!w.document.querySelector('.result.active').classList.contains('usage-tile'));
  key('ArrowUp');await wait(()=>w.document.querySelector('.usage-tile.active h3')?.textContent==='Recent website');
  const frequentOnly=await setup(t,{usage:{frequent:[appItem('Frequent only')],recent:[]}});
  assert.ok(frequentOnly.w.document.querySelector('#results').textContent.includes('暂无最近使用'));
  assert.equal(frequentOnly.w.document.querySelectorAll('.usage-tile').length,1);
  frequentOnly.key('ArrowDown');await wait(()=>!frequentOnly.w.document.querySelector('.result.active').classList.contains('usage-tile'));
  frequentOnly.key('ArrowUp');await wait(()=>frequentOnly.w.document.querySelector('.usage-tile.active h3')?.textContent==='Frequent only');
});

test('F6 on a usage entry returns to search without opening a result menu',async t=>{
  const {w,q,key}=await setup(t,{usage:{frequent:[],recent:[appItem('Recent only')]}});
  await wait(()=>w.document.querySelector('.usage-tile.active h3')?.textContent==='Recent only');
  key('F6');assert.equal(w.document.activeElement,q);assert.equal(w.document.querySelector('.search-context-menu'),null);
});

test('F6 cycles selected clipboard inline and menu actions then returns to search',async t=>{
  const {w,q,key}=await setup(t);
  await wait(()=>w.document.querySelector('.clipboard-result.active [data-clipboard-toggle]'));
  key('F6');assert.ok(w.document.activeElement.matches('[data-clipboard-toggle]'));
  const advance=()=>w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'F6',bubbles:true,cancelable:true}));
  advance();await wait(()=>w.document.activeElement.matches('.search-context-menu .tool-action'));
  assert.equal(w.document.activeElement.dataset.clipboardAction,'pin');
  advance();assert.equal(w.document.activeElement.dataset.clipboardAction,'plain');
  advance();assert.equal(w.document.activeElement.dataset.clipboardAction,'edit');
  advance();assert.equal(w.document.activeElement.dataset.clipboardAction,'delete');
  advance();assert.equal(w.document.activeElement,q);
});
test('F6 opens a regular application menu and returns after its final action',async t=>{
  const {w,q,key,scope}=await setup(t);await scope('app');q.focus();
  key('F6');await wait(()=>w.document.activeElement.matches('.search-context-menu .tool-action'));
  assert.equal(w.document.activeElement.dataset.resultAction,'open');
  const advance=()=>w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'F6',bubbles:true,cancelable:true}));
  advance();assert.equal(w.document.activeElement.dataset.resultAction,'copy');
  advance();assert.equal(w.document.activeElement,q);
});
test('F6 reaches long application expansion and menu actions before returning to search',async t=>{
  const {w,q,key,scope}=await setup(t,{search:(id,args,fixture)=>id==='app'?[{id:'long',title:'Long app',path:'/Applications/'+('Long Directory/'.repeat(30))+'End.app'}]:fixture[id]||[]});await scope('app');q.focus();
  key('F6');assert.ok(w.document.activeElement.matches('.search-content-toggle'));
  const advance=()=>w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'F6',bubbles:true,cancelable:true}));
  advance();await wait(()=>w.document.activeElement.dataset.resultAction==='open');
  advance();assert.equal(w.document.activeElement.dataset.resultAction,'copy');
  advance();assert.equal(w.document.activeElement,q);
});
test('application metadata updates per query; native icon hydration stays asynchronous and ignores stale replies',async t=>{
  let resolveOld;const iconCalls=[];
  const {w,input,scope,calls}=await setup(t,{search:(id,args,fixture)=>id==='app'?[{id:args.query||'initial',title:args.query||'Initial App',path:`/${args.query||'initial'}.app`}]:fixture[id]||[],loadAppIcons:async paths=>{
    iconCalls.push(paths);
    if(paths[0]==='/old.app')return new Promise(resolve=>{resolveOld=resolve;});
    return Object.fromEntries(paths.map(p=>[p,'data:image/png;base64,newIcon']));
  }});
  await scope('app');await wait(()=>w.document.querySelector('.app-result img'));
  assert.ok(calls.filter(c=>c[0]==='search'&&c[1]==='app').every(c=>c[2].includeIcons===false));
  await input('old');await wait(()=>resolveOld);await input('new');
  await wait(()=>w.document.querySelector('.app-result h3')?.textContent==='new');
  resolveOld({'/old.app':'data:image/png;base64,STALE'});await delay(20);
  assert.equal(w.document.querySelector('.app-result h3').textContent,'new');assert.ok(!w.document.querySelector('.app-result img').src.includes('STALE'));
  assert.ok(iconCalls.some(paths=>paths[0]==='/new.app'));
});
test('native first activation focuses after two paints and reopening resets query without losing navigation',async t=>{
  const {w,q,input,key,calls}=await setup(t,{native:true});
  await input('previous');q.blur();const frames=[],original=w.requestAnimationFrame;
  w.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
  w.dispatchEvent(new w.Event('focus'));assert.notEqual(w.document.activeElement,q);
  frames.shift()();assert.notEqual(w.document.activeElement,q);frames.shift()();assert.equal(w.document.activeElement,q);
  assert.equal(q.selectionStart,0);assert.equal(q.selectionEnd,q.value.length);w.requestAnimationFrame=original;
  w.prepareForShow();await wait(()=>q.value==='');assert.equal(w.document.activeElement,q);
  key('Tab');q.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Tab',bubbles:true}));await wait(()=>w.document.querySelector('[data-scope="clipboard"]').getAttribute('aria-pressed')==='true');
  assert.equal(calls.filter(c=>c[0]==='hide').length,0);
});
test('app click recovery ignores stale/mismatched releases and never turns clipboard press into paste',async t=>{
  const {w,scope,calls}=await setup(t);await scope('app');
  const row=w.document.querySelector('.app-result');
  const send=(target,type,timeStamp,extra={})=>{const e=new w.MouseEvent(type,{bubbles:true,button:0,detail:1,cancelable:true,...extra});Object.defineProperty(e,'timeStamp',{value:timeStamp});target.dispatchEvent(e);};
  send(row,'mousedown',100);assert.equal(calls.filter(c=>c[0]==='action').length,0);
  send(row,'mouseup',180);send(row,'click',180);await wait(()=>calls.filter(c=>c[0]==='action').length===1);
  send(row,'mouseup',480);send(row,'mousedown',400);send(row,'click',480);await delay(20);assert.equal(calls.filter(c=>c[0]==='action').length,2);
  send(row,'mouseup',780);await delay(120);send(row,'mousedown',700);assert.equal(calls.filter(c=>c[0]==='action').length,2);
  await scope('clipboard');const clipboard=w.document.querySelector('.clipboard-result');send(clipboard,'mouseup',1180);send(clipboard,'mousedown',1100);assert.equal(calls.filter(c=>c[0]==='action').length,2);
  send(clipboard,'click',1300,{detail:0});await wait(()=>calls.filter(c=>c[0]==='action').length===3);
});
