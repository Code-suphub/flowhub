// Development-only Plasmic adapter. Production receives local CSS, never this
// module, credentials, a design model, a network client, or example content.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const PROJECT='rKroot8WmpiogJg8366SaB';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:stable(value)).digest('hex');
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const allowed=new Set(('display position top right bottom left inset width height min-width min-height max-width max-height padding padding-top padding-right padding-bottom padding-left margin margin-top margin-right margin-bottom margin-left gap row-gap column-gap flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-self align-content justify-content justify-items justify-self grid-template-columns grid-template-rows grid-auto-flow grid-auto-columns grid-auto-rows grid-column grid-row grid-area grid-template-areas order overflow overflow-x overflow-y border border-width border-style border-color border-radius border-top border-right border-bottom border-left border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style border-bottom-style border-left-style border-top-color border-right-color border-bottom-color border-left-color background background-color color font-family font-size font-weight font-style line-height letter-spacing text-align text-overflow white-space word-break overflow-wrap box-sizing box-shadow opacity').split(' '));
export class LayoutError extends Error{constructor(code,message){super(message);this.code=code;}}
const fail=(code,message)=>{throw new LayoutError(code,message);};
async function credentials(file=process.env.PLASMIC_AUTH_FILE){
  try{const value=JSON.parse(await fs.readFile(file,'utf8'));if(value.host==='https://studio.plasmic.app'&&value.user&&value.token)return value;}catch{}
  fail('credentials','请设置有效的 PLASMIC_AUTH_FILE；认证只由开发服务读取。');
}
export async function projectRequest({metadata=false,authFile,signal,fetchImpl=fetch}={}){
  const auth=await credentials(authFile),suffix=metadata?'/revision-without-data':'';
  const response=await fetchImpl(`${auth.host}/api/v1/projects/${PROJECT}${suffix}`,{headers:{'x-plasmic-api-user':auth.user,'x-plasmic-api-token':auth.token},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  if(!response.ok)fail([401,403].includes(response.status)?'credentials':'network',`Plasmic HTTP ${response.status}`);
  const result=await response.json();
  if(result.rev?.projectId!==PROJECT||result.rev.branchId||!Number.isSafeInteger(result.rev.revision))fail('validation','返回了无关项目或分支。');
  return result;
}

/** Record only declared named regions; changes to content, structure or other
 * nodes are detected, never silently accepted as a functioning UI migration. */
export function snapshotLayouts(remote,layouts){
  const map=JSON.parse(remote.rev.data).map,ref=value=>value?.__ref?map[value.__ref]:value;
  function content(value,seen=new Set()){
    if(Array.isArray(value))return value.map(item=>content(item,new Set(seen)));
    if(value?.__ref){if(seen.has(value.__ref))return value;seen.add(value.__ref);return content(ref(value),seen);}
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='uuid').map(([key,item])=>[key,content(item,new Set(seen))]));
    return value;
  }
  const output={};
  for(const layout of layouts){
    const component=Object.values(map).find(value=>value.__type==='Component'&&value.name===layout.component);
    if(!component)fail('validation',`缺少设计组件：${layout.component}`);
    const names=new Set(Object.keys(layout.regions)),nodes={},structure=[];
    function visit(value,parent=''){
      const node=ref(value);if(!node)fail('validation','设计节点缺失。');
      const settings=(node.vsettings??[]).map(ref);
      if(settings.length!==1||ref(settings[0].variants?.[0])?.mediaQuery)fail('validation','请先适配新增的状态或断点变体。');
      const style=ref(settings[0].rs)?.values??{};
      const attribute=content(settings[0].attrs?.id);let id=typeof attribute==='string'?attribute:'';
      try{if(attribute?.code)id=JSON.parse(attribute.code);}catch{}
      const name=names.has(node.name)?node.name:typeof id==='string'&&id.startsWith('flowhub-layout-')?id.slice('flowhub-layout-'.length):node.name;
      const bound=names.has(name);
      if(bound){if(nodes[name])fail('validation',`区域名称重复：${name}`);nodes[name]={...style};}
      structure.push({type:node.__type,tag:node.tag,parent,name:name??'',component:node.component,attrs:content(settings[0].attrs),args:content(settings[0].args),text:content(node.text),styles:bound?null:style});
      for(const child of node.children??[])visit(child,bound?name:parent);
    }
    visit(component.tplTree);
    if(Object.keys(nodes).length!==names.size)fail('validation',`布局区域不完整：${layout.component}`);
    output[layout.id]={nodes,structure:hash(structure)};
  }
  return output;
}

function cssValue(property,value,map){
  property=({'flex-row-gap':'row-gap','flex-column-gap':'column-gap'})[property]??property;
  if(!allowed.has(property)||typeof value!=='string')fail('validation',`样式属性需要适配：${property}`);
  const tokens=Object.values(map).filter(item=>item.__type==='StyleToken');
  for(let i=0;i<4;i++)value=value.replace(/var\(--token-([\w-]+)\)/g,(all,id)=>tokens.find(item=>item.uuid===id)?.value??all);
  if(/[{};@]|url\s*\(|expression\s*\(|javascript:|var\(--token-/i.test(value)||value.length>1024)fail('validation',`样式值需要适配：${property}`);
  return [property,value];
}
export function compileLayouts(remote,config,baseline){
  const current=snapshotLayouts(remote,config.layouts),map=JSON.parse(remote.rev.data).map;
  const rules=['/* Generated from named Plasmic layout regions. Do not edit. */'];
  for(const layout of config.layouts){
    const original=baseline[layout.id],next=current[layout.id];
    if(!original||original.structure!==next.structure)fail('validation',`内容或结构发生变化，请先适配：${layout.component}`);
    for(const [name,selector]of Object.entries(layout.regions)){
      if(!/^[a-z][\w-]*$/.test(layout.page)||/[{};@]/.test(selector))fail('validation','无效的本地页面映射。');
      const properties=[];
      for(const [property,value]of Object.entries(next.nodes[name])){
        if(original.nodes[name][property]!==value)properties.push(cssValue(property,value,map).join(': '));
      }
      if(properties.length)rules.push(`${selector.split(',').map(part=>`html[data-plasmic-page="${layout.page}"] ${part.trim()}`).join(',\n')} {\n  ${properties.join(';\n  ')};\n}`);
    }
  }
  return {css:rules.join('\n\n')+'\n',snapshot:current};
}

export async function readLayoutState(root){
  const config=JSON.parse(await fs.readFile(path.join(root,'design/plasmic/layouts.json'),'utf8'));
  const state=JSON.parse(await fs.readFile(path.join(root,'design/plasmic/layout-state.json'),'utf8'));
  const css=await fs.readFile(path.join(root,config.output),'utf8');
  if(hash(css)!==state.cssHash)fail('local-edits','同步样式有本地改动，请先处理；不会覆盖。');
  return {config,state};
}

export async function syncLayouts({root,authFile,fetchImpl=fetch,signal,remote}={}){
  const lock=path.join(root,'design/plasmic/.layout-sync-lock');
  let handle;
  try{handle=await fs.open(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('busy','另一个布局同步正在运行。');throw error;}
  try{
    const before=await readLayoutState(root);
    remote??=await projectRequest({authFile,fetchImpl,signal});
    if(remote.rev.revision<before.state.revision)fail('validation','拒绝旧版设计。');
    const {css}=compileLayouts(remote,before.config,before.state.baseline);
    const after=await readLayoutState(root);
    if(stable(after)!==stable(before))fail('local-edits','同步期间发生本地改动，请先处理。');
    signal?.throwIfAborted();
    const changed=hash(css)!==before.state.cssHash;
    const next={...before.state,revision:remote.rev.revision,cssHash:hash(css)};
    // CSS is replaced atomically. The manifest is developer metadata only.
    if(changed){const staged=path.join(root,before.config.output+'.next');await fs.writeFile(staged,css);signal?.throwIfAborted();await fs.rename(staged,path.join(root,before.config.output));}
    if(stable(next)!==stable(before.state))await fs.writeFile(path.join(root,'design/plasmic/layout-state.json'),JSON.stringify(next,null,2)+'\n');
    return {revision:next.revision,changed,modules:before.config.layouts.length};
  }finally{await handle.close();await fs.rm(lock,{force:true});}
}

/** Poll metadata serially, with backoff, and keep the previous local CSS on
 * failure. The browser sees only a redacted, read-only status object. */
export function layoutDevPlugin({root,authFile=process.env.PLASMIC_AUTH_FILE,interval=3000,fetchImpl=fetch}={}){
  let stopped=false,timer,running,status={phase:'disabled',revision:null},controller;
  return {
    name:'flowhub-layout-auto-sync',apply:'serve',
    transformIndexHtml(html){return html.replace('</body>','<script type="module" src="/@flowhub/layout-status"></script></body>');},
    resolveId(id){if(id==='/@flowhub/layout-status')return '\0flowhub-layout-status';},
    load(id){if(id==='\0flowhub-layout-status')return `
      const note=document.createElement('aside');note.setAttribute('role','status');note.dataset.layoutSyncStatus='';
      Object.assign(note.style,{position:'fixed',right:'6px',bottom:'6px',maxWidth:'min(320px,90vw)',zIndex:'2147483640',padding:'4px 8px',borderRadius:'6px',font:'11px/1.5 system-ui',background:'var(--fh-surface,#fff)',color:'var(--fh-muted,#64748b)',pointerEvents:'none',boxShadow:'0 1px 5px #0002'});
      document.body.append(note);let eventSeen=false;
      const render=value=>{note.dataset.phase=value.phase;note.textContent=value.phase==='ready'?'Plasmic 自动同步 · r'+value.revision:value.message||'Plasmic '+value.phase;};
      const receive=value=>{eventSeen=true;render(value);};import.meta.hot?.on('flowhub:layout-status',receive);
      fetch('/__flowhub-layout/status').then(r=>r.json()).then(value=>{if(!eventSeen)render(value);}).catch(()=>render({phase:'error',message:'开发同步服务已断开'}));
      import.meta.hot?.dispose(()=>{import.meta.hot?.off('flowhub:layout-status',receive);note.remove();});
    `;},
    configureServer(server){
      controller=new AbortController();let failures=0;
      server.middlewares.use('/__flowhub-layout/status',(req,res)=>{if(req.method!=='GET'){res.writeHead(405);res.end();return;}res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(status));});
      if(!authFile||process.env.PLASMIC_AUTOSYNC==='0'){status={phase:'disabled',revision:null,message:'设置 PLASMIC_AUTH_FILE 后启动 plasmic:dev。'};return;}
      const publish=value=>{const previous=status;status=value;server.ws.send({type:'custom',event:'flowhub:layout-status',data:status});if(previous.phase!==value.phase||previous.revision!==value.revision)server.config.logger.info(`[Plasmic] ${value.phase} · revision ${value.revision??'—'}${value.message?' · '+value.message:''}`);};
      const check=()=>{
        if(stopped||running)return;
        running=(async()=>{
          try{
            const {state}=await readLayoutState(root);
            if(status.phase==='disabled')publish({phase:'checking',revision:state.revision});
            const meta=await projectRequest({metadata:true,authFile,fetchImpl,signal:controller.signal});
            if(meta.rev.revision!==state.revision){publish({phase:'syncing',revision:state.revision});await syncLayouts({root,authFile,fetchImpl,signal:controller.signal});}
            const current=await readLayoutState(root);failures=0;
            if(!stopped)publish({phase:'ready',revision:current.state.revision,modules:current.config.layouts.length});
          }catch(error){if(!stopped){failures++;publish({phase:'error',revision:status.revision,message:error instanceof LayoutError?error.message:'连接失败，保留上次预览并自动重试。'});}}
        })().finally(()=>{running=null;if(!stopped)timer=setTimeout(check,Math.min(30000,interval*2**Math.min(failures,4)));});
      };
      check();
    },
    async closeBundle(){stopped=true;clearTimeout(timer);controller?.abort();await running;}
  };
}

export async function runLayoutCli(root,args=process.argv.slice(2)){
  if(args.length>1||args.some(value=>!['--apply','--check'].includes(value)))fail('validation','用法：plasmic:sync [--apply | --check]');
  if(args.includes('--apply'))return syncLayouts({root});
  const {state,config}=await readLayoutState(root);return {mode:args.includes('--check')?'verified':'plan',revision:state.revision,modules:config.layouts.length};
}

export {hash as layoutHash};
