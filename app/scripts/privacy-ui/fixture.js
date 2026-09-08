window.fixtureCalls=[];
window.fixtureErrors=[];
addEventListener('error',event=>fixtureErrors.push(event.message));
addEventListener('unhandledrejection',event=>fixtureErrors.push(String(event.reason)));
window.fixtureConfig={core:{},plugins:{clipboard:{enabled:true,settings:{}},web:{enabled:true,settings:{items:[]}},memo:{enabled:true,settings:{items:[]}},app:{enabled:true},tools:{enabled:true}}};
const copy=value=>JSON.parse(JSON.stringify(value));
window.__TAURI__={event:{listen:async()=>()=>{}},core:{invoke:async(name,args)=>{
  fixtureCalls.push({name,args:copy(args||{})});
  if(name==='get_config') return copy(fixtureConfig);
  if(name==='save_config') {fixtureConfig=copy(args.config);return {ok:true,config:copy(fixtureConfig),storageState:{operation:'save'},pluginFailures:[]};}
  if(name==='get_config_path_info') return {activePath:'/synthetic/config.json'};
  if(name==='get_storage_info') return {activePath:'/synthetic/storage',defaultPath:'/synthetic/storage'};
  if(name==='search_clipboard') return [{id:1,kind:'text',hash:'synthetic-fixture-hash',copyCount:1,content:'synthetic history',createdAt:'2026-09-09',lastSeenAt:'2026-09-09'}];
  if(name==='search_usage') return {frequent:[],recent:[]};
  if(name==='search_applications') return [];
  if(name==='inspect_cloudflare') return {cloudflare:false,status:200,evidence:[]};
  if(name.startsWith('get_')) return {};
  throw Error('Unexpected isolated IPC: '+name);
}}};
