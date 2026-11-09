const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {JSDOM}=require('jsdom');
const bundle=readFileSync(resolve(__dirname,'../../ui/react/host.js'),'utf8');
const wait=async predicate=>{for(let i=0;i<120;i++){if(predicate())return;await new Promise(done=>setTimeout(done,10));}assert.ok(predicate(),'alert did not settle');};
function setup(t,invoke){
 const dom=new JSDOM('<div id="script-alert-root"></div>',{url:'http://localhost/script-alert.html',runScripts:'outside-only',pretendToBeVisual:true});
 dom.window.__TAURI__={core:{invoke}};dom.window.eval(bundle);t.after(()=>dom.window.close());return dom.window;
}
const context={id:'auth-test',sourceNames:'<img src=x onerror=alert(1)>',preview:false};
test('source hint renders as text and opening sends one fixed action even after repeated clicks',async t=>{
 const calls=[];let finish;
 const w=setup(t,async(command,args)=>{calls.push({command,...args});if(args.action==='context')return context;return new Promise(resolve=>{finish=resolve;});});
 await wait(()=>w.document.body.textContent.includes(context.sourceNames));assert.equal(w.document.querySelector('img'),null);
 assert.equal(w.document.querySelector('h1').textContent,'FlowHub · 认证窗口');
 assert.match(w.document.querySelector('[role="status"]').textContent,/^线索 · /);
 const button=[...w.document.querySelectorAll('button')].find(b=>b.textContent.includes('查看来源'));
 button.click();button.click();await wait(()=>finish);assert.deepEqual(calls.filter(c=>c.action==='open'),[{command:'script_alert_api',action:'open'}]);finish(null);
});
test('failed navigation keeps the hint and allows an explicit retry without changing its target',async t=>{
 let attempts=0;
 const w=setup(t,async(_,{action})=>{if(action==='context')return context;if(action==='open'&&++attempts===1)throw Error('详情暂不可打开');return null;});
 await wait(()=>w.document.body.textContent.includes(context.sourceNames));
 const button=[...w.document.querySelectorAll('button')].find(b=>b.textContent.includes('查看来源'));button.click();
 await wait(()=>w.document.querySelector('[role="alert"]'));assert.equal(button.disabled,false);button.click();await wait(()=>attempts===2);
});
test('close requests only dismissal',async t=>{
 const calls=[];const w=setup(t,async(_,{action})=>{calls.push(action);return action==='context'?context:null;});
 await wait(()=>w.document.body.textContent.includes(context.sourceNames));w.document.querySelector('[aria-label="关闭提示"]').click();await wait(()=>calls.includes('dismiss'));assert.equal(calls.includes('open'),false);
});
test('the keychain requester replaces the coincident script hint',async t=>{
 const w=setup(t,async()=>({...context,sourceNames:'Unrelated script',requestApp:'Arc'}));
 await wait(()=>w.document.querySelector('[role="status"]')?.textContent==='钥匙串 · Arc');
 assert.doesNotMatch(w.document.body.textContent,/Unrelated script/);
});
