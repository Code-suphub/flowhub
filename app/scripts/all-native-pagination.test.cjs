const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../ui/search.js'),'utf8');
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b));
(async()=>{
 for(const id of ['clipboard','web','memo']) {
  let calls=0;
  const state={scope:'all',query:'test',clipboardResults:[],webResults:[],memoResults:[],memoHasMore:true,memoLoading:false,clipboardHasMore:true,webHasMore:true,clipboardLoading:false,webLoading:false,emptyResults:{}};
  const ctx=vm.createContext({state,window:{weborg:{pluginSearch:async(name,request)=>{assert.equal(name,id);calls++;return Array.from({length:request.offset===0?2:1},(_,i)=>({id:request.offset+i+1}));}}},pluginEnabled:()=>true,clipboardSearchToken:0,webSearchToken:0,memoSearchToken:0,CLIPBOARD_PAGE_SIZE:2,PLUGIN_PAGE_SIZE:2,render(){},hydrateClipboardAssets(){},Set});
  vm.runInContext(slice('async function refreshClipboard(', 'async function hydrateClipboardAssets(')+slice('async function refreshWeb(', 'async function refreshMemos(')+slice('async function refreshMemos(', 'async function refreshUsage('),ctx);
  const fn=ctx[id==='web'?'refreshWeb':id==='memo'?'refreshMemos':'refreshClipboard'];
  await fn({append:true,deferRender:true});assert.equal(calls,1,'all must reach real source');
  state.scope='unrelated';await fn({append:true});assert.equal(calls,1,'unrelated scope blocked');
  state.scope='all';state[id+'Loading']=true;await fn({append:true});assert.equal(calls,1,'concurrent append blocked');
 }
 console.log('PASS: real clipboard/web/memo append functions accept all scope, reject unrelated scope and concurrent calls');
})().catch(e=>{console.error(e);process.exitCode=1});
