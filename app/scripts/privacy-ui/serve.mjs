// Isolated browser fixture: never loads a real config, database or clipboard.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const ui=path.resolve(here,'../../ui');
const config=JSON.parse(await readFile(path.resolve(here,'../../src-tauri/tauri.conf.json'),'utf8'));
const csp=config.app.security.csp;
createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'settings.html';
  if(!/^[a-zA-Z0-9_.-]+$/.test(name)) {res.writeHead(404).end();return;}
  try {
    let body=await readFile(path.join(['fixture.js','checks.js'].includes(name)?here:ui,name));
    if(name.endsWith('.html')) body=Buffer.from(body.toString().replace('<script src="tauri-adapter.js">','<script src="fixture.js"></script><script src="tauri-adapter.js">').replace('</body>','<button id="privacyChecks" style="position:fixed;right:10px;top:10px;z-index:99999">Run isolated privacy checks</button><pre id="privacyReport" style="position:fixed;right:10px;bottom:10px;z-index:99999;background:white;color:black;max-width:500px;white-space:pre-wrap"></pre><script src="checks.js"></script></body>'));
    res.writeHead(200,{'content-security-policy':csp,'cache-control':'no-store','content-type':name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.json')?'application/json':'application/octet-stream'});res.end(body);
  } catch {res.writeHead(404).end();}
}).listen(8767,'127.0.0.1',()=>console.log('Isolated UI + production CSP: http://127.0.0.1:8767/settings.html?module=clipboard'));
