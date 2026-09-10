// Dedicated in-memory market preview. Never reads user data or installs plugins.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
const mock=`(()=>{let sources=[],installed=[];const manifest={schema:2,id:'preview',name:'示例插件',version:'1.0.0',description:'仅用于市场交互预览',ui:'ui/index.html'};window.__TAURI__={core:{invoke:async(method,{action,payload})=>{switch(action){case 'list':return installed;case 'sources':return sources;case 'saveSource':sources=[{...payload,id:payload.id||'preview-source'}];return sources;case 'removeSource':sources=[];return [];case 'scanSource':return {plugins:[{manifest,source:payload.id,token:'preview-token'}],warnings:[]};case 'installCandidate':installed=[{manifest,enabled:true,directory:'/模拟插件目录'}];return installed;case 'reload':return installed;case 'enable':installed[0].enabled=payload.enabled;return installed;case 'uninstall':installed=[];return [];case 'chooseSource':return '/模拟插件来源';default:throw Error('预览不支持此操作');}}}};})();`;
http.createServer(async(req,res)=>{
 const name=new URL(req.url,'http://localhost').pathname.slice(1)||'plugin-market.html';
 if(!['plugin-market.html','plugin-market.css','plugin-market.js'].includes(name)){res.writeHead(404).end();return;}
 try{let body=await readFile(new URL('../ui/'+name,import.meta.url),'utf8');if(name.endsWith('.html'))body=body.replace('<script src="plugin-market.js">','<script>'+mock+'</script><script src="plugin-market.js">');res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':'text/javascript');res.end(body);}catch{res.writeHead(500).end();}
}).listen(5194,'127.0.0.1',()=>console.log('Mock plugin market: http://127.0.0.1:5194'));
