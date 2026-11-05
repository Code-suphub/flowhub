const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
const fs=require('node:fs'),path=require('node:path');
const app=path.resolve(__dirname,'../..');
for(const scopeId of ['clipboard','all'])for(const query of ['', 'fixture'])test(`clipboard updates reorder ${scopeId} results and retain record selection with query ${JSON.stringify(query)}`,async t=>{
  const record=(id,content,pinnedAt='')=>({id,kind:'text',content,hash:String(id),pinnedAt,copyCount:1});
  const pinned=record(1,'fixture pinned','2026-09-01T00:00:00Z'),recent=record(2,'fixture recent'),old=record(3,'fixture reused');
  let records=[pinned,recent,old];
  const {w,q,input,scope,key,calls,events}=await setup(t,{previewExpanded:true,search:id=>id==='clipboard'?records:[]});
  await scope(scopeId);if(query)await input(query);
  const titles=()=>[...w.document.querySelectorAll('.clipboard-result h3')].map(row=>row.textContent);
  await wait(()=>titles().length===3);
  key('ArrowDown');key('ArrowDown');
  await wait(()=>w.document.querySelector('.result.active h3')?.textContent===old.content);
  const searchesBefore=calls.filter(call=>call[0]==='search').length;
  records=[pinned,{...old,copyCount:2,lastSeenAt:'2026-09-03T00:00:00Z'},recent];
  events.onClipboardUpdated();
  await wait(()=>titles()[1]===old.content);
  assert.deepEqual(titles(),[pinned.content,old.content,recent.content]);
  assert.equal(w.document.querySelector('.result.active h3').textContent,old.content);
  assert.equal(w.document.querySelector('.preview-content').textContent,old.content);
  assert.equal(w.document.querySelector('.preview-properties').textContent.includes('2 次'),true);
  assert.equal(q.value,query);assert.equal(w.document.activeElement,q);
  assert.deepEqual(calls.filter(call=>call[0]==='search').slice(searchesBefore).map(call=>call[1]),['clipboard']);
  assert.equal(calls.some(call=>call[0]==='action'||call[0]==='copy'),false);
  w.prepareForShow();
  await wait(()=>w.document.querySelector('.result.active h3')?.textContent===pinned.content);
  assert.equal(q.value,'');
});
test('slow external opens freeze usage reordering and hover, deduplicate activation, and recover on failure',async t=>{
  const page=id=>({type:'page',id,title:id,url:`https://example.com/${id}`});
  const {w,key,events}=await setup(t,{usage:{frequent:[page('A'),page('B')],recent:[]}});
  const active=()=>w.document.querySelector('.result.active h3')?.textContent;
  let rejectOpen,opened=0;
  w.weborg.pluginAction=()=>{opened++;return new Promise((_,reject)=>{rejectOpen=reject;});};
  const rows=[...w.document.querySelectorAll('.usage-tile')];
  rows[0].dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,button:0}));await wait(()=>opened===1);
  const before=w.document.getElementById('results').textContent;
  w.weborg.searchUsage=async()=>({frequent:[page('B'),page('A')],recent:[]});
  events.onUsageUpdated();await delay(30);
  for(let x=50;x<53;x++)rows[1].dispatchEvent(new w.MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:100}));
  rows[0].click();rows[1].click();key('Enter');key('ArrowDown');await delay(30);
  assert.equal(opened,1);
  assert.equal(active(),'A');
  assert.equal(w.document.getElementById('results').textContent,before);
  rejectOpen(new Error('Browser fixture failed'));
  await wait(()=>w.document.getElementById('actionStatus').textContent==='Browser fixture failed');
  assert.equal(active(),'A','the original target remains selected even if usage order changed');
  w.weborg.pluginAction=async()=>{opened++;return {ok:true};};
  w.document.querySelector('.usage-tile').dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,button:0}));await wait(()=>opened===2);
});
test('a reopened launcher ignores a previous activation failure without unlocking the new activation',async t=>{
  const {w,input,scope,key}=await setup(t);
  await scope('web');await input('Website');
  const pending=[];
  w.weborg.pluginAction=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
  key('Enter');await wait(()=>pending.length===1);
  w.prepareForShow();await input('Website');key('Enter');await wait(()=>pending.length===2);
  pending[0].reject(new Error('STALE launch error'));await delay(30);
  assert.doesNotMatch(w.document.getElementById('actionStatus').textContent,/STALE/);
  key('Enter');await delay(30);assert.equal(pending.length,2);
  pending[1].resolve({ok:true});await delay(30);
  key('Enter');await wait(()=>pending.length===3);pending[2].resolve({ok:true});
});
test('failed activation preserves the query and allows a deliberate retry',async t=>{
  const {w,input,scope,key,q}=await setup(t);
  await scope('web');await input('Website');
  w.weborg.pluginAction=async()=>({ok:false,reason:'Cannot open fixture'});
  key('Enter');await wait(()=>w.document.getElementById('actionStatus').textContent==='Cannot open fixture');
  assert.equal(q.value,'Website');assert.equal(w.document.querySelector('.result.active h3').textContent,'Website');
  let opened=0;w.weborg.pluginAction=async()=>{opened++;return {ok:true};};
  key('Enter');await wait(()=>opened===1);
});
test('all tool views are React; JSON precision, URL parts, network output, port confirmation and cancellation remain available',async t=>{
  const {w,input}=await setup(t);
  for(const [query,text] of [['1+2','3'],['1700000000','时间戳'],['{"large":9007199254740993}','9007199254740993'],['https://example.com/a?x=1','URL 解析'],['port 80','确认'],['ping example.com','Ping 连通性'],['ip','公网 IP'],['8.8.8.8','Fixture city'],['dns example.com','DNS'],['proxy','代理信息']]){
    await input(query);
    if(query==='port 80'){await wait(()=>w.document.querySelector('[data-tool-action="terminate"]'));w.document.querySelector('[data-tool-action="terminate"]').click();await wait(()=>w.document.querySelector('[data-tool-action="confirm"]'));w.document.querySelector('[data-tool-action="cancel"]').click();await wait(()=>!w.document.querySelector('[data-tool-action="confirm"]'));}
    else {await wait(()=>w.document.getElementById('results').textContent.includes(text));assert.ok(w.document.getElementById('results').textContent.includes(text),query);}
    if(query.startsWith('ping')){w.document.querySelector('[data-tool-action="run"]').click();await wait(()=>w.document.getElementById('results').textContent.includes('fixture output'));}
  }
});
test('stale queries cannot overwrite newer input; pagination is deduplicated and bounded by a result window',async t=>{
  let resolveOld;
  const {w,input,scope}=await setup(t,{search:(id,args,fixture)=>{
    if(id==='web' && args.query==='old')return new Promise(resolve=>{resolveOld=resolve;});
    if(id==='web')return Array.from({length:30},(_,i)=>({id:`${args.query}:${(args.offset||0)+i}`,title:args.query || `Page ${i}`,url:'https://example.com'}));
    return args.offset?[]:fixture[id]||[];
  }});
  await scope('web');await input('old');await input('new');resolveOld([{id:'stale',title:'STALE RESULT'}]);await delay(30);assert.ok(!w.document.getElementById('results').textContent.includes('STALE RESULT'));
  for(let i=0;i<4;i++){w.document.getElementById('results').dispatchEvent(new w.Event('scroll',{bubbles:true}));await delay(30);}
  assert.ok(w.document.querySelectorAll('.result').length<80);
  assert.equal(new Set([...w.document.querySelectorAll('.result')].map(el=>el.id)).size,w.document.querySelectorAll('.result').length);
});
test('pagination updates the accessible set size on retained and virtualized options',async t=>{
  const {w,input,scope}=await setup(t,{search:(id,args)=>id==='web'?Array.from({length:30},(_,i)=>({id:`page:${(args.offset||0)+i}`,title:`Page ${(args.offset||0)+i}`,url:'https://example.com'})):[]});
  await scope('web');await input('page');
  const results=w.document.getElementById('results'), first=w.document.getElementById('search-result-0');
  assert.equal(first.getAttribute('aria-setsize'),'30');
  for(const total of [60,90]) {
    results.dispatchEvent(new w.Event('scroll',{bubbles:true}));
    await wait(()=>w.document.querySelector(`[aria-setsize="${total}"]`));
    assert.equal(w.document.getElementById('search-result-0'),first);
    const options=[...results.querySelectorAll('[role="option"]')];
    for(const option of options) {
      assert.equal(option.getAttribute('aria-setsize'),String(total));
      assert.equal(Number(option.getAttribute('aria-posinset')),Number(option.dataset.i)+1);
    }
    if(total===90)assert.ok(options.length<total,'the assertion also covers a virtualized list');
  }
});
test('clear search participates in the F6 cycle and returns focus without switching scope or activating results',async t=>{
  const {w,q,input,scope,key,calls}=await setup(t,{previewExpanded:true});
  await scope('web');await input('Website');
  const clear=w.document.querySelector('.search-clear');
  const press=(element,value,extra={})=>element.dispatchEvent(new w.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...extra}));
  key('F6');assert.equal(w.document.activeElement,clear);
  press(clear,'F6',{shiftKey:true});assert.equal(w.document.activeElement,q);
  key('F6');press(clear,'Tab');
  q.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Tab',bubbles:true,cancelable:true}));
  assert.equal(w.document.activeElement,q);
  assert.equal(w.document.querySelector('[data-scope="web"]').getAttribute('aria-pressed'),'true');
  key('F6');press(clear,'F6');
  await wait(()=>w.document.activeElement.matches('.search-preview-actions .tool-action'));
  press(w.document.activeElement,'F6',{shiftKey:true});assert.equal(w.document.activeElement,clear);
  press(clear,'Escape');assert.equal(w.document.activeElement,q);
  assert.equal(calls.filter(call=>call[0]==='hide').length,0);
  for(const value of ['Enter',' ']) {
    await input('Website');key('F6');
    const button=w.document.activeElement;
    assert.ok(button.matches('.search-clear'));
    assert.equal(press(button,value),true,'native keyboard activation is not prevented');
    // JSDOM does not synthesize the native button click from Enter/Space.
    button.click();await wait(()=>!w.document.querySelector('.search-clear'));
    assert.equal(q.value,'');assert.equal(w.document.activeElement,q);
  }
  assert.equal(calls.filter(call=>call[0]==='action').length,0);
});
test('clear search remains reachable with no result actions',async t=>{
  const {w,q,input,scope,key}=await setup(t,{search:()=>[]});
  await scope('web');await input('missing');
  key('F6');assert.ok(w.document.activeElement.matches('.search-clear'));
  w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'F6',shiftKey:true,bubbles:true,cancelable:true}));
  assert.equal(w.document.activeElement,q);
});
test('search migration contains no HTML proxy or legacy result markup renderer',()=>{
  const files=['ui/search/search.js','ui/search/port-tool.js','ui/search/network-tools.js','ui/search/json-tool.js','ui/search/url-tool.js','ui/search/local-ip-tool.js','src/search/index.tsx','src/search/Results.tsx','src/search/Tools.tsx'];
  for(const file of files)assert.doesNotMatch(fs.readFileSync(path.join(app,file),'utf8'),/innerHTML|dangerouslySetInnerHTML|DOMParser|renderResultBody|panelHtml/);
});
test('clipboard copy editor uses shared Textarea and keeps cancel behavior',async t=>{
  const {w,scope}=await setup(t);
  await scope('clipboard');
  w.document.querySelector('.clipboard-result').dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  await wait(()=>w.document.querySelector('[data-clipboard-action="edit"]'));
  w.document.querySelector('[data-clipboard-action="edit"]').click();
  await wait(()=>w.document.querySelector('[data-clipboard-editor]'));
  const editor=w.document.querySelector('[data-clipboard-editor]');
  assert.equal(editor.getAttribute('data-slot'),'textarea');
  assert.match(editor.value,/text line/);
  w.document.querySelector('[data-clipboard-action="edit-cancel"]').click();
  await wait(()=>!w.document.querySelector('[data-clipboard-editor]'));
});
test('React history and parameter templates expose replay/copy/remove controls and remain absent in read-only preview',async t=>{
  const {w,input}=await setup(t);await input('ping example.com');
  w.document.querySelector('[data-tool-action="run"]').click();await wait(()=>w.document.querySelector('[data-tool-action="history-run"]'));
  w.document.querySelector('[data-tool-action="template-save"]').click();await wait(()=>w.document.querySelector('[data-tool-action="template-run"]'));
  assert.ok(w.document.querySelector('[data-tool-action="history-copy"]'));assert.ok(w.document.querySelector('[data-tool-action="template-forget"]'));
  w.document.querySelector('[data-tool-action="history-forget"]').click();await wait(()=>!w.document.querySelector('[data-tool-action="history-run"]'));
  const preview=await setup(t,{readonly:true});await preview.input('ping example.com');
  assert.equal(preview.w.document.querySelector('[data-tool-action="template-save"]'),null);
  assert.equal(preview.w.localStorage.length,0);
});
test('mount/dispose removes subscriptions and the native diagnostic bridge; remount is safe',async t=>{
  const {w,unmount,remount,events}=await setup(t,{native:true});
  assert.ok(w.FlowHubSearchDiagnostics);const report=w.FlowHubSearchDiagnostics.inspect();
  assert.ok(report.initialized);assert.doesNotMatch(JSON.stringify(report),/danger|Application|example\.com/);
  unmount();assert.equal(w.FlowHubSearchDiagnostics,undefined);assert.equal(Object.keys(events).length,0);
  const dispose=remount();t.after(dispose);await wait(()=>w.FlowHubSearchDiagnostics?.inspect().initialized);
});

test('long application details move to the preview while list summaries stay bounded',async t=>{
  const apps=['A','B'].map(id=>({id,title:`${id} ${'长应用名称'.repeat(28)} TITLE-END-${id}`,path:`/Applications/${'Long Directory/'.repeat(25)}${id}-PATH-END.app`}));
  const {w,scope,key,calls,q}=await setup(t,{previewExpanded:true,search:(id,args,fixture)=>id==='app'?(args.offset?[]:apps):fixture[id]||[]});await scope('app');
  const rows=[...w.document.querySelectorAll('.app-result')];assert.equal(rows.length,2);
  for(const row of rows)assert.doesNotMatch(row.querySelector('.search-meta').textContent,/PATH-END/);
  assert.match(w.document.querySelector('.search-preview').textContent,/A-PATH-END/);
  key('ArrowDown');await wait(()=>rows[1].getAttribute('aria-selected')==='true');
  assert.match(w.document.querySelector('.search-preview').textContent,/B-PATH-END/);assert.equal(w.document.activeElement,q);
  rows[0].querySelector('.result-preview-button').click();await wait(()=>rows[0].getAttribute('aria-selected')==='true');
  assert.match(w.document.querySelector('.search-preview').textContent,/A-PATH-END/);assert.equal(calls.filter(c=>c[0]==='action').length,0);
  q.focus();key('Enter');await wait(()=>calls.some(c=>c[0]==='action'&&c[3].path===apps[0].path));
});
test('multi-line commands are readable and copyable without pasting or expanding list rows',async t=>{
  const command='first line\nsecond line\nthird line\nCOMMAND-END';
  const memos=['a','b'].map(id=>({id,title:'命令 '+id,category:'测试',content:command}));
  const {w,scope,calls,input}=await setup(t,{previewExpanded:true,search:(id,args,fixture)=>id==='memo'?(args.offset?[]:memos):fixture[id]||[]});await scope('memo');
  const rows=[...w.document.querySelectorAll('.memo-result')];assert.ok(!rows[0].textContent.includes('COMMAND-END'));
  rows[1].click();await wait(()=>rows[1].getAttribute('aria-selected')==='true');assert.equal(w.document.querySelector('.preview-content').textContent,command);
  w.document.querySelector('.search-preview-actions [data-result-action="copy"]').click();await wait(()=>calls.some(c=>c[0]==='copy'&&c[1]===command));
  assert.equal(calls.filter(c=>c[0]==='action').length,0);
  await input('命令');assert.equal(w.document.querySelectorAll('.memo-result')[1],rows[1]);assert.equal(w.document.querySelector('.preview-content').textContent,command);
});
test('clipboard full-text previews remain read-only and bounded; copy obtains the entire record',async t=>{
  const contents=['first\n'+('line\n'.repeat(5000))+'CLIP-END','other\nsecond\n<script>unsafe()</script>\nOTHER-END'];
  const {w,scope,key,calls}=await setup(t,{readonly:true,autoPreviewLongContent:false,search:(id,args,fixture)=>id==='clipboard'?(args.offset?[]:contents.map((content,i)=>({id:i+1,kind:'text',content}))):fixture[id]||[]});await scope('clipboard');
  key('i',{metaKey:true,code:'KeyI'});await wait(()=>w.document.querySelector('.preview-content'));w.document.getElementById('q').focus();
  const rows=[...w.document.querySelectorAll('.clipboard-result')];assert.ok(rows[0].querySelector('.clipboard-title').textContent.length<=100);
  assert.equal(w.document.querySelector('.preview-content').textContent.length,20000);
  assert.equal(w.document.querySelector('.search-preview-actions [data-result-action="copy"]').disabled,true);
  key('ArrowDown');await wait(()=>rows[1].getAttribute('aria-selected')==='true');assert.equal(w.document.querySelector('.preview-content').textContent,contents[1]);
  assert.equal(w.document.querySelector('.search-preview script'),null);assert.equal(w.document.querySelector('#activateResultBtn').disabled,true);
  assert.equal(calls.filter(c=>c[0]==='action').length,0);assert.equal(w.localStorage.length,0);
  const native=await setup(t,{previewExpanded:true,search:(id,args,fixture)=>id==='clipboard'?[{id:1,kind:'text',content:contents[0]}]:fixture[id]||[]});await native.scope('clipboard');
  native.w.document.querySelector('.search-preview-actions [data-result-action="copy"]').click();await wait(()=>native.calls.some(c=>c[0]==='copy'&&c[1]===contents[0]));
});

test('preview shortcuts preserve focus, native Tab order and pending input',async t=>{
  const {w,q,key,input,calls}=await setup(t,{autoPreviewLongContent:false});await input('query');
  Object.defineProperty(w.document,'hasFocus',{configurable:true,value:()=>true});
  key('i',{metaKey:true,code:'KeyI'});await wait(()=>w.document.activeElement.matches('.search-preview-body'));
  const body=w.document.activeElement,scope=w.document.querySelector('[data-scope][aria-pressed="true"]').dataset.scope;
  assert.equal(body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})),true);
  w.dispatchEvent(new w.Event('focus'));await delay(25);assert.equal(w.document.activeElement,body);
  body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(w.document.activeElement,q);
  assert.equal(w.document.querySelector('[data-scope][aria-pressed="true"]').dataset.scope,scope);assert.equal(calls.filter(c=>c[0]==='hide').length,0);
  key('i',{metaKey:true,code:'KeyI'});await wait(()=>!w.document.querySelector('.search-preview'));
  key('i',{metaKey:true,code:'KeyI'});q.value='new typing';q.dispatchEvent(new w.Event('input',{bubbles:true}));await delay(35);
  assert.equal(w.document.activeElement,q,'an obsolete preview focus frame cannot steal new input');assert.equal(q.value,'new typing');
});

test('narrow preview returns to results on Escape or input and keeps menus outside the hidden list',async t=>{
  const {w,q,key,scope,input}=await setup(t,{width:390});await scope('clipboard');
  const workbench=w.document.querySelector('.search-workbench');
  w.document.querySelector('.clipboard-result').click();await wait(()=>workbench.dataset.detailOpen==='true');
  w.document.getElementById('resultActionsBtn').click();await wait(()=>w.document.querySelector('[role="menu"]'));
  assert.equal(w.document.querySelector('[role="menu"]').closest('#results'),null);
  w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await wait(()=>!w.document.querySelector('[role="menu"]'));assert.equal(workbench.dataset.detailOpen,'true','Escape closes only the top layer');assert.equal(w.document.activeElement,q);
  key('Escape');await wait(()=>workbench.dataset.detailOpen==='false');
  key('F6');assert.equal(w.document.activeElement.id,'activateResultBtn','hidden preview actions cannot trap keyboard focus');
  q.focus();w.document.querySelector('.clipboard-result').click();await wait(()=>workbench.dataset.detailOpen==='true');await input('new');
  assert.equal(workbench.dataset.detailOpen,'false');assert.equal(w.document.activeElement,q);
});
