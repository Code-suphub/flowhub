// Standalone synthetic adapter: no filesystem, clipboard, network or IPC.
(() => {
  if (window.__TAURI__ || window.weborg) throw new Error('fixture-requires-isolated-page');
  const plugins=['clipboard','app','web','memo'].map((id,order)=>({id,name:id,order,available:true,enabled:true,searchable:true}));
  let rows=[], delays={}, bridge=null, resolveConnected;
  const connected=new Promise(resolve=>{resolveConnected=resolve;});
  const api=Object.freeze({
    listPlugins:async()=>plugins,getConfig:async()=>({plugins:{}}),
    async pluginSearch(id,{query='',offset=0,limit=30}={}) {
      const records=id==='clipboard'?rows:[], delay=delays[id] || 0;
      if(delay) await new Promise(resolve=>setTimeout(resolve,delay));
      return records.filter(record=>!query || record.content.includes(query)).slice(offset,offset+limit);
    },
    searchUsage:async()=>({frequent:[],recent:[]}),getUpdateState:async()=>({}),
    getDiagnosticsState:async()=>({enabled:false}),
    pluginAction:async()=>({ok:false,readonly:true,reason:'Synthetic fixture is read-only'}),
    copyText:async()=>{throw new Error('Synthetic fixture cannot copy');},
    openSettings:async()=>{},hideMain:async()=>{},
    onConfig(){},onClipboardUpdated(){},onUsageUpdated(){},onUpdateState(){}
  });
  document.documentElement.dataset.weborgReadonly='true';
  window.weborg=api;
  window.FlowHubSearchFixture=Object.freeze({
    api, connected,
    connect(value){bridge=value;resolveConnected(value);},
    disconnect(value){if(bridge===value)bridge=null;},
    configure({count=0,long=false,marker='',sourceDelays={}}={}) {
      if(!Number.isInteger(count)||count<0||count>3000)throw new Error('fixture-count-out-of-range');
      delays={...sourceDelays};
      rows=Array.from({length:count},(_,i)=>({id:i+1,kind:'text',
        content:marker || (long&&i===0?'test '.repeat(28000):`synthetic record ${i} ${'text '.repeat(30)}`),
        hash:'0123456789abcdef',copyCount:1,lastSeenAt:'2026-09-07T00:00:00Z'}));
    },
    bridge(){return bridge;}
  });
})();
