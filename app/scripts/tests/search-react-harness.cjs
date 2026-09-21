const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const {buildSync}=require('esbuild');
const app=path.resolve(__dirname,'../..');
const bundle=buildSync({stdin:{contents:"export {mountSearch} from './src/search';",resolveDir:app,loader:'tsx'},bundle:true,write:false,format:'iife',globalName:'SearchTest',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn){for(let i=0;i<150;i++){if(fn())return;await delay(10);}assert.ok(fn(),'search did not settle');}
async function setup(t,{readonly=false,search,native=false,usage,loadAppIcons}={}) {
  const dom=new JSDOM('<div id="search-root"></div>',{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window, calls=[], events={};
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  if(readonly)w.document.documentElement.dataset.weborgReadonly='true';
  if(native)w.__TAURI__={core:{invoke:async()=>{}}};
  const plugins=['clipboard','app','web','memo','twofa','tools'].map((id,order)=>({id,name:id,order,enabled:true,available:true,searchable:id!=='tools'}));
  const fixture={clipboard:[{id:1,kind:'text',content:'<script>danger()</script>\n'+'text line\n'.repeat(40),hash:'123456789012345',copyCount:2}],app:[{id:'app',title:'Application',path:'/Applications/Test.app'}],web:[{id:'web',title:'Website',url:'https://example.com'}],memo:[{id:'memo',title:'Memo',category:'开发',content:'echo fixture'}],twofa:[{id:'otp',title:'OTP',issuer:'Fixture'}]};
  w.weborg={listPlugins:async()=>plugins,getConfig:async()=>({core:{},plugins:{tools:{settings:{}}}}),getUpdateState:async()=>({currentVersion:'1.0-local.test'}),
    pluginSearch:async(id,args)=>{calls.push(['search',id,args]);return search?search(id,args,fixture):args.offset?[]:fixture[id]||[];},
    pluginAction:async(...args)=>{calls.push(['action',...args]);return args[0]==='twofa'?{code:'123456'}:{ok:true};},
    searchUsage:async()=>usage || {frequent:[],recent:[]},loadAppIcons,
    copyText:async text=>calls.push(['copy',text]),openSettings:async()=>calls.push(['settings']),hideMain:async()=>calls.push(['hide']),
    getLauncherPinned:async()=>false,setLauncherPinned:async p=>p,
    lookupDns:async()=>({Answer:[{type:1,data:'8.8.8.8'}]}),lookupIp:async()=>({city:'Fixture city'}),lookupProxy:async()=>({http:{enabled:false}}),lookupLocalIp:async()=>({ipv4:'1.2.3.4',pending:[]}),
    inspectPort:async port=>({port,processes:[{pid:123,name:'fixture',sockets:['*:80'],executable:'/fixture',identity:'private-token'}]}),
    runNetworkDiagnostic:async()=>({output:'fixture output',exitCode:0,elapsedMs:1}),
  };
  for(const name of ['onConfig','onClipboardUpdated','onUsageUpdated','onUpdateState'])w.weborg[name]=fn=>{events[name]=fn;return()=>delete events[name];};
  w.eval(fs.readFileSync(path.join(app,'ui/shared/command-store.js'),'utf8'));
  for(const name of ['tool-registry','search-window','port-tool','local-ip-tool','network-tools','json-tool','url-tool','search'])w.eval(fs.readFileSync(path.join(app,'ui/search',name+'.js'),'utf8'));
  w.eval(bundle);const unmount=w.SearchTest.mountSearch(w.document.getElementById('search-root'));
  t.after(()=>{unmount();dom.window.close();});
  await wait(()=>w.document.querySelectorAll('[data-scope]').length===6);
  const q=w.document.getElementById('q');
  const input=async value=>{q.value=value;q.dispatchEvent(new w.Event('input',{bubbles:true}));await delay(300);};
  const scope=async id=>{w.document.querySelector(`[data-scope="${id}"]`).click();await delay(30);};
  const key=(key,extra={})=>q.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
  return {w,q,input,scope,key,calls,events,unmount,remount:()=>w.SearchTest.mountSearch(w.document.getElementById('search-root'))};
}
module.exports={setup,wait,delay};
