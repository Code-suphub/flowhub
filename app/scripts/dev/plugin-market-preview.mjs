// Dedicated in-memory preview for the React plugin host. It never reads user data or installs plugins.
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const mock = `(()=>{
  const manifests=[
    {id:'preview.notes',name:'便笺整理',version:'1.2.0',description:'为工作区的便笺添加轻量标签和快捷整理。'},
    {id:'preview.focus',name:'专注计时',version:'0.8.1',description:'在菜单栏显示专注时段与休息提醒。'},
    {id:'preview.export',name:'摘要导出',version:'2.0.0',description:'将选中的摘要导出为常见文本格式。'}
  ];
  let sources=[{id:'preview-source',name:'示例插件库',kind:'https',location:'https://example.invalid/plugins.json',key:''}];
  let installed=[{manifest:{...manifests[0]},directory:'/example/plugins/preview.notes',enabled:true,lastLoadedAt:Date.now()-3600000}];
  const preferences={tray:true,pinned:false,favorites:[]};
  const snapshot={title:'插件状态示例',monitoring:true,rows:[
    {id:'preview-machine-a',name:'示例工作站',status:'healthy',at:Date.now()-30000,values:{cpu:18.4,memory:62.1,disk:41.8}},
    {id:'preview-machine-b',name:'构建节点',status:'stale',at:Date.now()-900000,values:{cpu:4.2,memory:38.7,disk:73.0}},
    {id:'preview-machine-c',name:'测试环境',status:'error',at:Date.now()-120000,values:{cpu:0,memory:0,disk:0}}
  ]};
  if(location.pathname.endsWith('/plugin-status.html')&&!location.search)history.replaceState(null,'',location.pathname+'?id=preview-status');
  window.__TAURI__={core:{invoke:async(command,args={})=>{
    const action=args.action,payload=args.payload||{};
    if(command==='plugin_api') switch(action){
      case 'list': return installed.map(item=>({...item}));
      case 'sources': return sources.map(item=>({...item}));
      case 'scanSource': return {plugins:manifests.map((manifest,index)=>({manifest:{...manifest},source:payload.id,token:'preview-token-'+index})),warnings:[]};
      case 'saveSource': {const saved={...payload,id:payload.id||'preview-source-'+Date.now()};sources=[...sources.filter(item=>item.id!==saved.id),saved];return saved;}
      case 'removeSource': sources=sources.filter(item=>item.id!==payload.id);return null;
      case 'installCandidate': {const index=Number(String(payload.token).split('-').at(-1))||0;const manifest=manifests[index]||manifests[0];installed=[...installed.filter(item=>item.manifest.id!==manifest.id),{manifest:{...manifest},directory:'/example/plugins/'+manifest.id,enabled:true,lastLoadedAt:Date.now()}];return null;}
      case 'install': {const manifest={id:'preview.local',name:'本地开发插件',version:'0.1.0',description:'仅用于本地目录安装预览。'};installed=[...installed,{manifest,directory:String(payload.directory||'/example/plugins/local-dev'),enabled:true,lastLoadedAt:Date.now()}];return null;}
      case 'reload': return null;
      case 'enable': installed=installed.map(item=>item.manifest.id===payload.id?{...item,enabled:Boolean(payload.enabled)}:item);return null;
      case 'uninstall': installed=installed.filter(item=>item.manifest.id!==payload.id);return null;
      case 'chooseSource': return '/example/sources/local';
      case 'choose': return {manifest:{id:'preview.local',name:'本地开发插件',version:'0.1.0',description:'本地目录预览'},directory:'/example/plugins/local-dev'};
      default: throw Error('示例预览不支持此操作');
    }
    if(command==='plugin_canvas_api') return null;
    if(command==='plugin_status_api') switch(action){
      case 'get': return {snapshot,preferences:{...preferences,favorites:[...preferences.favorites]}};
      case 'save': Object.assign(preferences,payload);return {snapshot,preferences:{...preferences,favorites:[...preferences.favorites]}};
      case 'plugin': case 'menu': return null;
      default: throw Error('示例预览不支持此状态操作');
    }
    throw Error('示例预览仅支持插件市场与状态页面');
  }}};
})();`;

const allowed = new Map([
  ['plugin-market.html', ['plugin-market.html', 'text/html; charset=utf-8']],
  ['plugin-status.html', ['plugin-status.html', 'text/html; charset=utf-8']],
  ['react/host.js', ['react/host.js', 'text/javascript; charset=utf-8']],
  ['react/host.css', ['react/host.css', 'text/css; charset=utf-8']],
  ['shared/palette.css', ['shared/palette.css', 'text/css; charset=utf-8']],
  ['shared/theme.js', ['shared/theme.js', 'text/javascript; charset=utf-8']],
]);
const banner = '<aside style="padding:7px 12px;border-bottom:1px solid var(--fh-border);background:var(--fh-surface);color:var(--fh-muted);font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif">示例预览 · 所有操作仅保存在当前页面内存</aside>';

http.createServer(async (req, res) => {
  const name = new URL(req.url || '/', 'http://127.0.0.1').pathname.replace(/^\/+/, '') || 'plugin-market.html';
  const file = allowed.get(name);
  if (!file) { res.writeHead(404).end(); return; }
  try {
    let body = await readFile(new URL('../../ui/' + file[0], import.meta.url), 'utf8');
    if (name.endsWith('.html')) {
      body = body.replace(/(<body[^>]*>)/, `$1${banner}`);
      const hostScript = name === 'plugin-status.html' ? '<script defer src="react/host.js"></script>' : '<script src="react/host.js"></script>';
      body = body.replace(hostScript, `<script>${mock}</script>${hostScript}`);
    }
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  } catch {
    res.writeHead(500).end('Preview asset unavailable');
  }
}).listen(5194, '127.0.0.1', () => console.log('Mock plugin preview: http://127.0.0.1:5194'));
