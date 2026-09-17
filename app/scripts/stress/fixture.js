const fixturePlugins=['clipboard','app','web','memo'].map(id=>({id,name:id,available:true,enabled:true,searchable:true}));
window.weborg={listPlugins:async()=>fixturePlugins,getConfig:async()=>({plugins:{}}),pluginSearch:async()=>[],searchUsage:async()=>({frequent:[],recent:[]}),getUpdateState:async()=>({}),onConfig(){},onClipboardUpdated(){},onUsageUpdated(){},onUpdateState(){}};
