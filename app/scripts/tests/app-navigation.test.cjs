const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
const appItem=title=>({type:'app',title,path:`/Applications/${title}.app`});
test('both usage rows use linear vertical navigation and preserve input arrows, Enter, modifiers and IME',async t=>{
  const {w,q,key,scope,calls,input}=await setup(t,{usage:{frequent:['A','B','C'].map(appItem),recent:['D','E'].map(appItem)}});
  const active=()=>w.document.querySelector('.result.active h3')?.textContent;
  for(const id of ['all','app']) {
    await scope(id);assert.equal(active(),'A');
    assert.deepEqual([...w.document.querySelectorAll('.search-usage-label')].map(node=>node.textContent),['常用','最近']);
    assert.equal(key('ArrowRight'),true);assert.equal(active(),'A');
    key('ArrowDown');await wait(()=>active()==='B');
    key('ArrowDown');await wait(()=>active()==='C');
    key('ArrowDown');await wait(()=>active()==='D');key('Enter');await wait(()=>calls.some(c=>c[0]==='action'&&c[3].path==='/Applications/D.app'));
    key('ArrowUp');await wait(()=>active()==='C');key('ArrowUp');await wait(()=>active()==='B');
    assert.ok([...w.document.querySelectorAll('.usage-tile h3')].some(node=>node.textContent==='D'));
    key('Enter');await wait(()=>calls.some(c=>c[0]==='action'&&c[3].path==='/Applications/B.app'));
  }
  for(const modifier of ['metaKey','ctrlKey','altKey','shiftKey']) {
    assert.equal(key('ArrowRight',{[modifier]:true}),true);assert.equal(active(),'B');
  }
  q.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));const before=calls.length;
  key('Enter');assert.equal(calls.length,before);q.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));
  await input('search');await scope('app');assert.equal(key('ArrowRight'),true,'bare arrows in normal result rows belong to input');
  for(const [action,message] of [
    [async()=>({ok:false,reason:'应用路径为空'}),'应用路径为空'],
    [async()=>{throw 'Launch Services refused';},'Launch Services refused'],
    [()=>{throw new Error('native bridge failed');},'native bridge failed']
  ]) {w.weborg.pluginAction=action;key('Enter');await wait(()=>w.document.getElementById('actionStatus').textContent===message);}
  const previous=w.document.getElementById('actionStatus').textContent;
  w.weborg.pluginAction=async()=>({ok:false,cancelled:true});key('Enter');await delay(20);assert.equal(w.document.getElementById('actionStatus').textContent,previous);
  const web=await setup(t,{usage:{frequent:['A','B','C'].map(title=>({...appItem(title),type:'page',id:title,url:'https://example.com'})),recent:['D','E'].map(title=>({...appItem(title),type:'page',id:title,url:'https://example.com'}))}});
  await web.scope('web');assert.equal(web.key('ArrowRight'),true);web.key('ArrowDown');await wait(()=>web.w.document.querySelector('.result.active h3')?.textContent==='B');
  web.key('Enter');await wait(()=>web.calls.some(c=>c[0]==='action'&&c[1]==='web'&&c[3].id==='B'));
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
  const frequentOnly=await setup(t,{usage:{frequent:[appItem('Frequent only')],recent:[]}});
  assert.ok(frequentOnly.w.document.querySelector('#results').textContent.includes('暂无最近使用'));
  assert.equal(frequentOnly.w.document.querySelectorAll('.usage-tile').length,1);
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
