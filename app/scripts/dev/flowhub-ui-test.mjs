#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {readFile,writeFile,open,realpath,unlink,chmod} from 'node:fs/promises';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {UITestClient,webdriver} from './ui-test-client.mjs';
import {runPlan} from './ui-test-plan.mjs';

const app=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const args=process.argv.slice(2), action=args.shift();
const flags={};
let parseError;
const allowed=new Set(['data','module','package','binary','session','frame','ref','css','role','name','value','key','text','timeout','enabled','absent','output','plan']);
try { for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--') || args[i+1]===undefined)throw Error('options require values');const key=args[i].slice(2);if(!allowed.has(key) || key in flags)throw Error('unknown or repeated option');flags[key]=args[i+1];} } catch(error) { parseError=error; }
const frames=flags.frame?flags.frame.split('.').map(Number):[];
const target=flags.ref?{ref:flags.ref}:flags.css?{css:flags.css}:{role:flags.role,...(flags.name===undefined?{}:{name:flags.name})};
async function freePort(){const server=createServer();await new Promise((ok,bad)=>server.once('error',bad).listen(0,'127.0.0.1',ok));const {port}=server.address();await new Promise(ok=>server.close(ok));return port;}
async function start() {
  if(!flags.data)throw Error('start requires --data pointing to a disposable fixture directory');
  const root=await realpath(flags.data), token=randomBytes(32).toString('hex'), port=await freePort();
  const home=await realpath(homedir()), production=join(home,'Library/Application Support/FlowHub');
  const actualProduction=await realpath(production).catch(()=>production);
  if(root==='/' || root===home || [production,actualProduction].some(path=>root===path||root.startsWith(`${path}/`)))throw Error('refusing a production or home data directory');
  await chmod(root,0o700);
  await writeFile(join(root,'.flowhub-ui-test'),token,{flag:'wx',mode:0o600});
  const config={root,token,port,module:flags.module||'extensions',package:flags.package?await realpath(flags.package):null};
  const configFile=join(root,'ui-test-config.json'), sessionFile=join(root,'ui-test-session.json');
  await writeFile(configFile,JSON.stringify(config),{mode:0o600});
  const log=await open(join(root,'ui-test.log'),'a',0o600);
  const child=spawn(flags.binary||join(app,'src-tauri/target/debug/flowhub-ui-test'),[configFile],{detached:true,stdio:['ignore',log.fd,log.fd]});
  let launchError;child.once('error',error=>{launchError=error;});child.unref();await log.close();
  const endpoint=`http://127.0.0.1:${port}`;let id;
  try {
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      if(launchError)throw launchError;
      if(child.exitCode!==null || child.signalCode)throw Error(`test app exited; ${(await readFile(join(root,'ui-test.log'),'utf8')).trim().split('\n').at(-1) || 'inspect ui-test.log'}`);
      try {await webdriver(endpoint,'/status');break;}catch {await new Promise(ok=>setTimeout(ok,200));}
    }
    const result=await webdriver(endpoint,'/session',{capabilities:{alwaysMatch:{}}});id=result.sessionId;
    if(!id)throw Error('driver did not return a session');
    await webdriver(endpoint,`/session/${id}/timeouts`,{script:8000,implicit:0,pageLoad:10000});
    const session={endpoint,id,token,pid:child.pid,root,mode:'synthetic-dom'};
    const client=new UITestClient(session);
    const readyDeadline=Date.now()+15000;let ready=false;
    while(Date.now()<readyDeadline){try {await client.inspect();ready=true;break;}catch {await new Promise(ok=>setTimeout(ok,150));}}
    if(!ready)throw Error('test page did not initialize; inspect ui-test.log');
    await writeFile(sessionFile,JSON.stringify(session),{mode:0o600});
    return {session:sessionFile,pid:child.pid,mode:session.mode};
  } catch(error){
    if(id)await webdriver(endpoint,`/session/${id}`,undefined,'DELETE').catch(()=>{});
    child.kill('SIGTERM');
    if(await readFile(join(root,'.flowhub-ui-test'),'utf8')===token)await unlink(join(root,'.flowhub-ui-test'));
    throw error;
  }
}
async function main(){
  if(parseError)throw parseError;
  if(frames.some(index=>!Number.isInteger(index)||index<0))throw Error('invalid frame path');
  if(flags.timeout!==undefined && (!Number.isFinite(Number(flags.timeout)) || Number(flags.timeout)<=0 || Number(flags.timeout)>120000))throw Error('timeout must be between 1 and 120000 ms');
  if(!action || action==='help')return {usage:['start --data <fixture-dir> [--package <plugin-package>] [--module plugin:machines]','inspect --session <file> [--frame 0]','click|read --session <file> --role button --name <exact-label> [--frame 0]','fill --session <file> --css <selector> --value <text> [--frame 0]','key --session <file> --ref <ref> --key Enter [--frame 0]','wait --session <file> --css <selector> --text <expected> [--frame 0]','run --session <file> --plan <json> --output <new-directory>','screenshot --session <file> --output <png>','stop --session <file>'],scope:'test-only WKWebView DOM controls; not system input, IME, native dialogs or global focus'};
  if(action==='start')return start();
  if(!flags.session)throw Error('--session is required');
  const client=await UITestClient.open(flags.session);
  if(action==='run'){
    if(!flags.plan || !flags.output)throw Error('run requires --plan and --output');
    const source=await readFile(flags.plan,'utf8');if(source.length>200000)throw Error('plan is too large');
    const result=await runPlan(client,JSON.parse(source),resolve(flags.output));if(!result.success)process.exitCode=1;return result;
  }
  if(action==='inspect')return client.inspect(frames);
  if(action==='click')return client.click(target,frames);
  if(action==='fill')return client.fill(target,flags.value,frames);
  if(action==='read')return client.read(target,frames);
  if(action==='key')return client.request({op:'key',target,frames,key:flags.key});
  if(action==='wait')return client.wait(target,{frames,text:flags.text,enabled:flags.enabled===undefined?undefined:flags.enabled==='true',absent:flags.absent==='true',timeout:flags.timeout?Number(flags.timeout):30000});
  if(action==='screenshot'){if(!flags.output)throw Error('--output is required');return client.screenshot(resolve(flags.output));}
  if(action==='stop'){
    const current=await client.inspect();
    if(current.pid!==client.session.pid)throw Error('test process PID mismatch');
    await webdriver(client.session.endpoint,`/session/${client.session.id}`,undefined,'DELETE');
    process.kill(client.session.pid,'SIGTERM');
    let stopped=false;
    for(let i=0;i<50;i++){try{process.kill(client.session.pid,0);}catch(error){if(error.code==='ESRCH'){stopped=true;break;}throw error;}await new Promise(ok=>setTimeout(ok,100));}
    if(!stopped)throw Error('test process did not stop; retaining instance marker');
    const marker=join(client.session.root,'.flowhub-ui-test');
    if(await readFile(marker,'utf8')===client.session.token)await unlink(marker);
    return {stopped:true};
  }
  throw Error('unknown command; use help');
}
main().then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(JSON.stringify({error:error.message}));process.exitCode=1;});
