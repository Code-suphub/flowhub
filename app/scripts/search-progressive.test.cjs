const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../ui/search.js'),'utf8');
const fn=source.slice(source.indexOf('async function refreshAllScopes()'),source.indexOf('function queueClipboardRefresh'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 let fast=false,slow=false,early=false,renders=0;
 const ctx=vm.createContext({state:{scope:'all',query:'test'},allScopeRefreshToken:0,Promise,requestAnimationFrame:cb=>setTimeout(cb,0),refreshClipboard:async()=>{await delay(5);fast=true},refreshApps:async()=>{await delay(80);slow=true},refreshWeb:async()=>{},refreshMemos:async()=>{},render:()=>{renders++;if(fast&&!slow)early=true;}});
 vm.runInContext(fn,ctx);await ctx.refreshAllScopes();assert(early);await delay(5);renders=0;
 const pending=ctx.refreshAllScopes();ctx.state.scope='clipboard';await pending;await delay(5);assert.equal(renders,0);
 console.log('PASS: fast source renders before slow completion; stale scope completion cannot publish');
})().catch(e=>{console.error(e);process.exitCode=1});
