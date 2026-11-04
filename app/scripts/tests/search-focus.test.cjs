const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
test('scope bindings share Command aliases and preserve physical punctuation and numpad keys',async t=>{
  const {w,key,events}=await setup(t);
  Object.defineProperty(w.navigator,'platform',{configurable:true,value:'MacIntel'});
  await events.onConfig({core:{scopeShortcuts:{app:'Super+Numpad1',web:'Option+Shift+Equal',memo:'CmdOrCtrl+KeyM'}},plugins:{tools:{settings:{}}}});
  key('1',{code:'Digit1',metaKey:true});
  assert.notEqual(w.document.querySelector('[data-scope="app"]').getAttribute('aria-pressed'),'true');
  key('1',{code:'Numpad1',metaKey:true});await wait(()=>w.document.querySelector('[data-scope="app"]').getAttribute('aria-pressed')==='true');
  key('+',{code:'Equal',altKey:true,shiftKey:true});await wait(()=>w.document.querySelector('[data-scope="web"]').getAttribute('aria-pressed')==='true');
  key('m',{code:'KeyM',ctrlKey:true});assert.notEqual(w.document.querySelector('[data-scope="memo"]').getAttribute('aria-pressed'),'true');
  key('m',{code:'KeyM',metaKey:true});await wait(()=>w.document.querySelector('[data-scope="memo"]').getAttribute('aria-pressed')==='true');
});
test('scope primary press deduplicates click, F6/Escape, IME and bare cursor arrows preserve focus contracts',async t=>{
  const {w,q,scope,key,calls}=await setup(t);
  q.focus();q.value='preserve';
  const button=w.document.querySelector('[data-scope="app"]');
  const before=calls.length;button.dispatchEvent(new w.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));button.click();
  await wait(()=>button.getAttribute('aria-pressed')==='true');assert.equal(w.document.activeElement,q);assert.equal(q.value,'preserve');assert.equal(calls.length,before);
  key('F6');await wait(()=>w.document.activeElement.classList.contains('tool-action'));
  assert.ok(w.document.activeElement.closest('.search-preview-actions'));
  w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(w.document.activeElement,q);
  q.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));key('F6');assert.equal(w.document.activeElement,q);q.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));
  await scope('clipboard');assert.equal(key('ArrowLeft'),true);assert.equal(key('ArrowRight'),true);
  key('k',{metaKey:true,code:'KeyK'});assert.equal(q.selectionStart,0);assert.equal(q.selectionEnd,q.value.length);
  key('Escape');assert.equal(calls.filter(c=>c[0]==='hide').length,1);
});
test('Tab tap/hold changes scope once, config refresh retains the pressed button and cold app release/press does not execute',async t=>{
  const {w,q,scope,key,calls,events}=await setup(t);
  key('Tab');q.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Tab',bubbles:true,cancelable:true}));await wait(()=>w.document.querySelector('[data-scope="clipboard"]').getAttribute('aria-pressed')==='true');
  key('Tab');key('ArrowRight');q.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Tab',bubbles:true,cancelable:true}));await wait(()=>w.document.querySelector('[data-scope="app"]').getAttribute('aria-pressed')==='true');
  const button=w.document.querySelector('[data-scope="app"]');await events.onConfig({plugins:{tools:{settings:{}}}});await delay(20);assert.equal(w.document.querySelector('[data-scope="app"]'),button);
  const row=w.document.querySelector('.app-result');
  const release=new w.MouseEvent('mouseup',{button:0,bubbles:true});Object.defineProperty(release,'timeStamp',{value:200});row.dispatchEvent(release);
  const press=new w.MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true});Object.defineProperty(press,'timeStamp',{value:150});row.dispatchEvent(press);
  await delay(20);assert.equal(calls.filter(c=>c[0]==='action'&&c[1]==='app').length,0);assert.equal(w.document.activeElement,q);
});

test('search accepts focus before slow startup queries finish',async t=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  const {q}=await setup(t,{search:async(id,args,fixture)=>{await gate;return fixture[id]||[];},beforeReady:({w,q})=>{
    try{
      assert.ok(w.document.activeElement===q,'A pending backend must not delay keyboard input');
      q.value='startup typing';q.dispatchEvent(new w.Event('input',{bubbles:true}));
    }
    finally{release();}
  }});
  await delay(50);
  assert.equal(q.value,'startup typing');
  assert.equal(q.selectionStart,q.value.length);
});

test('window activation never selects characters typed before the next paint',async t=>{
  const {w,q,input}=await setup(t);
  q.focus();
  w.dispatchEvent(new w.FocusEvent('focus'));
  await input('already typing');
  q.setSelectionRange(q.value.length,q.value.length);
  // Dispatch again with typing between activation and its deferred callback.
  w.dispatchEvent(new w.FocusEvent('focus'));
  q.value+=' now';q.dispatchEvent(new w.Event('input',{bubbles:true}));
  q.setSelectionRange(q.value.length,q.value.length);
  await delay(70);
  assert.equal(q.selectionStart,q.value.length);
  assert.equal(q.selectionEnd,q.value.length);
});

test('a late activation callback cannot steal focus from a result action',async t=>{
  const {w,q,scope,key}=await setup(t);
  await scope('app');q.focus();
  w.dispatchEvent(new w.FocusEvent('focus'));
  key('F6');
  await wait(()=>w.document.activeElement.classList.contains('tool-action'));
  const action=w.document.activeElement;
  await delay(70);
  assert.ok(w.document.activeElement===action,'Late focus must preserve the focused result action');
});

test('reopening during clipboard editing preserves the visible draft and query',async t=>{
  const {w,q,input,scope,key}=await setup(t,{search:async(id,args,fixture)=>id==='clipboard'&&args.query==='older'
    ? [{id:99,kind:'text',content:'older entry',hash:'older'}] : fixture[id]||[]});
  await scope('clipboard');await input('older');
  key('e',{metaKey:true,code:'KeyE'});
  await wait(()=>w.document.querySelector('.clipboard-editor'));
  const editor=w.document.querySelector('.clipboard-editor');
  editor.focus();editor.value='unsaved draft';
  w.prepareForShow();
  await delay(70);
  assert.equal(q.value,'older');
  assert.ok(w.document.querySelector('.clipboard-editor')===editor,'Reopening must preserve the editor element');
  assert.equal(editor.value,'unsaved draft');
  assert.ok(w.document.activeElement===editor,'The draft must remain editable after reopening');
});
