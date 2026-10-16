const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
const fs=require('node:fs'),path=require('node:path');
const app=path.resolve(__dirname,'../..');
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

test('long app titles and paths collapse until selected or explicitly expanded without activating the row',async t=>{
  const apps=['A','B'].map(id=>({id,title:`${id} ${'长应用名称'.repeat(28)} TITLE-END-${id}`,path:`/Applications/${'Long Directory/'.repeat(25)}${id}-PATH-END.app`}));
  const {w,scope,key,calls}=await setup(t,{search:(id,args,fixture)=>id==='app'?(args.offset?[]:apps):fixture[id]||[]});await scope('app');
  const rows=[...w.document.querySelectorAll('.app-result')];assert.equal(rows.length,2);
  assert.equal(rows[0].querySelector('h3').textContent,apps[0].title);assert.match(rows[0].textContent,/A-PATH-END/);
  assert.doesNotMatch(rows[1].textContent,/B-PATH-END/);assert.equal(rows[1].dataset.fullContent,'false');
  key('ArrowDown');await wait(()=>rows[1].getAttribute('aria-selected')==='true');
  assert.equal(rows[1].querySelector('h3').textContent,apps[1].title);assert.match(rows[1].textContent,/B-PATH-END/);assert.doesNotMatch(rows[0].textContent,/A-PATH-END/);
  const before=calls.filter(call=>call[0]==='action').length;
  rows[0].querySelector('.search-content-toggle').click();await wait(()=>rows[0].dataset.fullContent==='true');
  assert.match(rows[0].textContent,/A-PATH-END/);assert.equal(calls.filter(call=>call[0]==='action').length,before);
  key('Enter');await wait(()=>calls.some(call=>call[0]==='action'&&call[3].path===apps[1].path));
});

test('multi-line commands preserve complete selected content and explicit expansion across unrelated renders',async t=>{
  const command='first line\nsecond line\nthird line\nCOMMAND-END';
  const memos=['a','b'].map(id=>({id,title:'命令 '+id,category:'测试',content:command}));
  const {w,scope,calls,input}=await setup(t,{search:(id,args,fixture)=>id==='memo'?(args.offset?[]:memos):fixture[id]||[]});await scope('memo');
  const rows=[...w.document.querySelectorAll('.memo-result')];assert.equal(rows[0].querySelector('code').textContent,command);assert.doesNotMatch(rows[1].querySelector('code').textContent,/COMMAND-END/);
  rows[1].querySelector('.search-content-toggle').click();await wait(()=>rows[1].querySelector('code').textContent===command);
  assert.equal(calls.filter(call=>call[0]==='action').length,0);
  await input('命令');assert.equal(w.document.querySelectorAll('.memo-result')[1],rows[1]);assert.equal(rows[1].querySelector('code').textContent,command);
});

test('clipboard previews use two lines before selection and expose the full original only on explicit expansion',async t=>{
  const contents=['first\nsecond\nthird\nfourth\nfifth\nCLIP-END','other\nsecond\nthird\nfourth\nfifth\nOTHER-END'];
  const {w,scope,key,calls}=await setup(t,{readonly:true,search:(id,args,fixture)=>id==='clipboard'?(args.offset?[]:contents.map((content,i)=>({id:i+1,kind:'text',content}))):fixture[id]||[]});await scope('clipboard');
  const rows=[...w.document.querySelectorAll('.clipboard-result')];assert.match(rows[0].querySelector('.clipboard-title').textContent,/fifth/);assert.doesNotMatch(rows[1].querySelector('.clipboard-title').textContent,/third/);
  key('ArrowDown');await wait(()=>rows[1].getAttribute('aria-selected')==='true');assert.match(rows[1].querySelector('.clipboard-title').textContent,/fifth/);assert.doesNotMatch(rows[0].querySelector('.clipboard-title').textContent,/third/);
  rows[1].querySelector('[data-clipboard-toggle]').click();await wait(()=>rows[1].querySelector('.clipboard-title').textContent==='other\nsecond\nthird\nfourth\nfifth\nOTHER-END');
  assert.equal(calls.filter(call=>call[0]==='action').length,0);assert.equal(w.localStorage.length,0);
  assert.doesNotMatch(rows[1].querySelector('.clipboard-meta').textContent,/·\s*·/);
});
