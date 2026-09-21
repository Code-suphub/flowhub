const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,wait,delay}=require('./search-react-harness.cjs');
const fs=require('node:fs'),path=require('node:path');
const app=path.resolve(__dirname,'../..');
test('all tool views are React; JSON precision, URL parts, network output, port confirmation and cancellation remain available',async t=>{
  const {w,input}=await setup(t);
  for(const [query,text] of [['1+2','3'],['1700000000','时间戳'],['{"large":9007199254740993}','9007199254740993'],['https://example.com/a?x=1','URL 解析'],['port 80','确认'],['ping example.com','Ping 连通性'],['ip','公网 IP'],['8.8.8.8','Fixture city'],['dns example.com','DNS'],['proxy','代理信息']]){
    await input(query);
    if(query==='port 80'){w.document.querySelector('[data-tool-action="terminate"]').click();await wait(()=>w.document.querySelector('[data-tool-action="confirm"]'));w.document.querySelector('[data-tool-action="cancel"]').click();await wait(()=>!w.document.querySelector('[data-tool-action="confirm"]'));}
    else assert.ok(w.document.getElementById('results').textContent.includes(text),query);
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
