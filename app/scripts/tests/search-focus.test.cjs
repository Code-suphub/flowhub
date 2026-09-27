const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
test('scope primary press deduplicates click, F6/Escape, IME and bare cursor arrows preserve focus contracts',async t=>{
  const {w,q,scope,key,calls}=await setup(t);
  q.focus();q.value='preserve';
  const button=w.document.querySelector('[data-scope="app"]');
  const before=calls.length;button.dispatchEvent(new w.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));button.click();
  await wait(()=>button.getAttribute('aria-pressed')==='true');assert.equal(w.document.activeElement,q);assert.equal(q.value,'preserve');assert.equal(calls.length,before);
  key('F6');await wait(()=>w.document.activeElement.classList.contains('tool-action'));
  assert.ok(w.document.activeElement.closest('[role="menu"]'));
  w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(w.document.activeElement,q);
  q.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));key('F6');assert.equal(w.document.activeElement,q);q.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));
  await scope('clipboard');assert.equal(key('ArrowLeft'),true);assert.equal(key('ArrowRight'),true);
  key('k',{metaKey:true,code:'KeyK'});assert.equal(q.selectionStart,0);assert.equal(q.selectionEnd,q.value.length);
  key('Escape');assert.equal(calls.filter(c=>c[0]==='hide').length,1);
});
test('Tab tap/hold changes scope once, config refresh retains the pressed button and cold app release/press launches once',async t=>{
  const {w,q,scope,key,calls,events}=await setup(t);
  key('Tab');q.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Tab',bubbles:true,cancelable:true}));await wait(()=>w.document.querySelector('[data-scope="clipboard"]').getAttribute('aria-pressed')==='true');
  key('Tab');key('ArrowRight');q.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Tab',bubbles:true,cancelable:true}));await wait(()=>w.document.querySelector('[data-scope="app"]').getAttribute('aria-pressed')==='true');
  const button=w.document.querySelector('[data-scope="app"]');await events.onConfig({plugins:{tools:{settings:{}}}});await delay(20);assert.equal(w.document.querySelector('[data-scope="app"]'),button);
  const row=w.document.querySelector('.app-result');
  const release=new w.MouseEvent('mouseup',{button:0,bubbles:true});Object.defineProperty(release,'timeStamp',{value:200});row.dispatchEvent(release);
  const press=new w.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true});Object.defineProperty(press,'timeStamp',{value:150});row.dispatchEvent(press);
  await delay(20);assert.equal(calls.filter(c=>c[0]==='action'&&c[1]==='app').length,1);assert.equal(w.document.activeElement,q);
});
