const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
const appItem=title=>({type:'app',title,path:`/Applications/${title}.app`});
test('hover never changes selection; click previews and double-click executes exactly once',async t=>{
  const clips=[1,2,3].map(id=>({id,kind:'text',content:`clipboard ${id}\n`+'long line\n'.repeat(10)}));
  const {w,q,key,scope,calls}=await setup(t,{native:true,search:(id,args,fixture)=>id==='clipboard'?clips:fixture[id]||[]});await scope('clipboard');
  const row=index=>w.document.querySelector(`.result[data-i="${index}"]`),active=()=>Number(w.document.querySelector('.result.active').dataset.i);
  key('ArrowDown');await wait(()=>active()===1);
  for(const x of [50,50,51])row(0).dispatchEvent(new w.MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:150}));
  assert.equal(active(),1);assert.match(w.document.querySelector('.preview-content').textContent,/clipboard 2/);
  row(0).click();await wait(()=>active()===0);assert.equal(w.document.activeElement,q);
  assert.equal(calls.filter(c=>c[0]==='action').length,0);
  row(0).dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,button:0}));
  await wait(()=>calls.filter(c=>c[0]==='action').length===1);
  assert.equal(calls.find(c=>c[0]==='action')[3].id,1);
});
test('hover preserves the preferred usage column until an explicit click',async t=>{
  const {w,key}=await setup(t,{usage:{frequent:['A','B','C'].map(appItem),recent:['D','E'].map(appItem)}});
  const active=()=>w.document.querySelector('.result.active h3')?.textContent;
  const c=[...w.document.querySelectorAll('.usage-tile')].find(row=>row.querySelector('h3').textContent==='C');
  key('ArrowRight');await wait(()=>active()==='B');
  c.dispatchEvent(new w.MouseEvent('mousemove',{bubbles:true,clientX:100,clientY:100}));assert.equal(active(),'B');
  key('ArrowDown');await wait(()=>active()==='E');key('ArrowUp');await wait(()=>active()==='B');
  c.click();await wait(()=>active()==='C');key('ArrowDown');await wait(()=>active()==='E');key('ArrowUp');await wait(()=>active()==='C');
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
    [...w.document.querySelectorAll('.usage-tile')].find(row=>row.querySelector('h3').textContent==='C').click();
    await wait(()=>active()==='C');
    key('ArrowDown');await wait(()=>active()==='E');key('Enter');await wait(()=>calls.some(c=>c[0]==='action'&&c[3].path==='/Applications/E.app'));
    // Navigation resumes after the opener settles, rather than when it is called.
    await delay(0);
    key('ArrowUp');await wait(()=>active()==='C','clamping the shorter row preserves the original column');
    key('ArrowDown');await wait(()=>active()==='E');
    key('ArrowDown');await wait(()=>!w.document.querySelector('.result.active').classList.contains('usage-tile'));
    key('ArrowUp');await wait(()=>active()==='E');key('ArrowUp');await wait(()=>active()==='C');
    assert.ok([...w.document.querySelectorAll('.usage-tile h3')].some(node=>node.textContent==='D'));
    key('Enter');await wait(()=>calls.some(c=>c[0]==='action'&&c[3].path==='/Applications/C.app'));
    await delay(0);
    key('ArrowDown');await wait(()=>active()==='E');
    w.document.querySelector('.usage-tile.active').click();
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

test('F6 cycles preview, primary and menu actions for apps, usage and clipboard then returns to search',async t=>{
  for(const target of ['app','usage','clipboard']) {
    const {w,q,key,scope}=await setup(t,target==='usage'?{usage:{frequent:[appItem('A')],recent:[]}}:{});
    if(target!=='usage')await scope(target);
    const seen=[];key('F6');
    for(let i=0;i<18 && w.document.activeElement!==q;i++) {
      const current=w.document.activeElement;
      assert.ok(current.classList.contains('tool-action'));
      seen.push(current.dataset.resultAction || current.dataset.clipboardAction);
      current.dispatchEvent(new w.KeyboardEvent('keydown',{key:'F6',bubbles:true,cancelable:true}));await delay(5);
    }
    assert.equal(w.document.activeElement,q,'the action cycle terminates at search');
    assert.ok(seen.includes('copy'));assert.ok(seen.includes('open'));
    if(target==='clipboard'){assert.ok(seen.includes('edit'));assert.ok(seen.includes('delete'));}
  }
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
test('native activation restores input without selecting typing; reopening resets query and retains navigation',async t=>{
  const {w,q,input,key,calls}=await setup(t,{native:true});
  await input('previous');q.blur();
  Object.defineProperty(w.document,'hasFocus',{configurable:true,value:()=>true});
  w.dispatchEvent(new w.Event('focus'));await wait(()=>w.document.activeElement===q);
  await delay(50);
  assert.equal(q.selectionStart,q.value.length);assert.equal(q.selectionEnd,q.value.length);
  w.prepareForShow();await wait(()=>q.value==='');assert.equal(w.document.activeElement,q);
  key('Tab');q.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Tab',bubbles:true}));await wait(()=>w.document.querySelector('[data-scope="clipboard"]').getAttribute('aria-pressed')==='true');
  assert.equal(calls.filter(c=>c[0]==='hide').length,0);
});
test('out-of-order presses and single clicks never execute applications or clipboard records',async t=>{
  const {w,scope,calls}=await setup(t);
  for(const target of ['app','clipboard']) {
    await scope(target);const row=w.document.querySelector(`.${target}-result`);
    for(const type of ['mouseup','mousedown','click','mouseup','mousedown','click'])row.dispatchEvent(new w.MouseEvent(type,{bubbles:true,button:0,cancelable:true}));
    await delay(20);assert.equal(calls.filter(c=>c[0]==='action').length,0);
    row.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,button:0}));
    await wait(()=>calls.some(c=>c[0]==='action'&&c[1]===target));
    calls.length=0;
  }
});
