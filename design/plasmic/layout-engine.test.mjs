import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileLayouts,snapshotLayouts,syncLayouts,layoutHash,layoutDevPlugin,PROJECT} from './layout-engine.mjs';

const ref=id=>({__ref:id});
function fixture(){
 const map={component:{__type:'Component',name:'LinkedSearch',tplTree:ref('root')},root:{__type:'TplTag',name:'root',tag:'main',vsettings:[ref('vs')],children:[ref('child')]},child:{__type:'TplTag',name:'header',tag:'header',vsettings:[ref('child-vs')],children:[],text:ref('text')},text:{__type:'RawText',text:'Public fixture'},vs:{rs:ref('rs'),attrs:{}},'child-vs':{rs:ref('child-rs'),attrs:{}},rs:{values:{'padding-left':'12px',display:'flex'}},'child-rs':{values:{gap:'8px'}}};
 const config={output:'ui/plasmic-layouts.css',layouts:[{id:'search',component:'LinkedSearch',page:'search',regions:{root:'.search-shell',header:'.search-header'}}]};
 return {config,remote:()=>({rev:{projectId:PROJECT,revision:2,data:JSON.stringify({map})}}),map};
}
test('only declared region style deltas become local scoped CSS; baseline remains unchanged',()=>{
 const {config,map,remote}=fixture(),baseline=snapshotLayouts(remote(),config.layouts);
 assert.doesNotMatch(compileLayouts(remote(),config,baseline).css,/padding/);
 map.rs.values['padding-left']='16px';map['child-rs'].values.gap='10px';
 const css=compileLayouts(remote(),config,baseline).css;
 assert.match(css,/html\[data-plasmic-page="search"\] \.search-shell/);assert.match(css,/padding-left: 16px/);assert.match(css,/gap: 10px/);
 assert.doesNotMatch(css,/display:/);
});
test('content edits, missing bindings, structure changes and unsupported variants stop synchronization',()=>{
 for(const mutate of [map=>{map.text.text='new label';},map=>{map.child.name='renamed';},map=>{map.root.children=[];},map=>{map.vs.variants=[ref('screen')];map.screen={mediaQuery:'(max-width: 600px)'};}]){
  const {config,map,remote}=fixture(),baseline=snapshotLayouts(remote(),config.layouts);mutate(map);
  assert.throws(()=>compileLayouts(remote(),config,baseline),{code:'validation'});
 }
});
test('CSS resources, injection and unknown properties are rejected; semantic tokens are resolved locally',()=>{
 for(const [key,value]of [['background','url(https://example.com/x)'],['color','red; display:none'],['unsupported-private-key','x']]){
  const {config,map,remote}=fixture(),baseline=snapshotLayouts(remote(),config.layouts);map.rs.values[key]=value;
  assert.throws(()=>compileLayouts(remote(),config,baseline),{code:'validation'});
 }
 const {config,map,remote}=fixture(),baseline=snapshotLayouts(remote(),config.layouts);
 map.token={__type:'StyleToken',uuid:'accent',value:'var(--fh-accent)'};map.rs.values.color='var(--token-accent)';
 assert.match(compileLayouts(remote(),config,baseline).css,/color: var\(--fh-accent\)/);
});
test('managed CSS writes preserve manual edits, reject older revisions and never touch business files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'flowhub-layout-engine-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'design/plasmic'),{recursive:true});await mkdir(join(root,'ui'));
 const {config,map,remote}=fixture(),baseline=snapshotLayouts(remote(),config.layouts),css=compileLayouts(remote(),config,baseline).css;
 await writeFile(join(root,config.output),css);await writeFile(join(root,'ui/business.js'),'keep behavior');
 await writeFile(join(root,'design/plasmic/layouts.json'),JSON.stringify(config));
 await writeFile(join(root,'design/plasmic/layout-state.json'),JSON.stringify({revision:1,cssHash:layoutHash(css),baseline}));
 map.rs.values['padding-left']='16px';assert.equal((await syncLayouts({root,remote:remote()})).changed,true);
 assert.match(await readFile(join(root,config.output),'utf8'),/16px/);
 await assert.rejects(syncLayouts({root,remote:{...remote(),rev:{...remote().rev,revision:0}}}),{code:'validation'});
 await writeFile(join(root,config.output),'manual CSS edit');
 await assert.rejects(syncLayouts({root,remote:remote()}),{code:'local-edits'});
 assert.equal(await readFile(join(root,config.output),'utf8'),'manual CSS edit');
 assert.equal(await readFile(join(root,'ui/business.js'),'utf8'),'keep behavior');
});

test('public HTML IDs bind native tag nodes and every alternative selector keeps its page scope',()=>{
 const {config,map,remote}=fixture();
 map.root.name=null;map.child.name=null;
 map.vs.attrs={id:{code:'"flowhub-layout-root"'}};map['child-vs'].attrs={id:{code:'"flowhub-layout-header"'}};
 config.layouts[0].regions.root='.first, .second';
 const baseline=snapshotLayouts(remote(),config.layouts);map.rs.values.color='red';
 const css=compileLayouts(remote(),config,baseline).css;
 assert.match(css,/html\[data-plasmic-page="search"\] \.first,\nhtml\[data-plasmic-page="search"\] \.second/);
 map.vs.attrs.id={code:'executeSomething()'};
 assert.throws(()=>snapshotLayouts(remote(),config.layouts),{code:'validation'});
});

test('development polling recovers from failure, exposes safe GET-only status and stops on close',async t=>{
 const root=await mkdtemp(join(tmpdir(),'flowhub-layout-dev-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'design/plasmic'),{recursive:true});await mkdir(join(root,'ui'));
 const {config,map,remote}=fixture(),baseline=snapshotLayouts(remote(),config.layouts),css=compileLayouts(remote(),config,baseline).css;
 await writeFile(join(root,config.output),css);await writeFile(join(root,'design/plasmic/layouts.json'),JSON.stringify(config));
 await writeFile(join(root,'design/plasmic/layout-state.json'),JSON.stringify({revision:1,cssHash:layoutHash(css),baseline}));
 const authFile=join(root,'private.json');await writeFile(authFile,JSON.stringify({host:'https://studio.plasmic.app',user:'fixture-account',token:'fixture-secret'}));
 let attempts=0,active=0,maxActive=0,handler;const events=[];
 const plugin=layoutDevPlugin({root,authFile,interval:10,fetchImpl:async url=>{
  active++;maxActive=Math.max(maxActive,active);
  try{if(url.endsWith('revision-without-data')){attempts++;if(attempts===1)return new Response('',{status:500});return Response.json({rev:{projectId:PROJECT,revision:2}});}map.rs.values.color='red';return Response.json(remote());}
  finally{active--;}
 }});
 const server={middlewares:{use(_url,fn){handler=fn;}},ws:{send(event){events.push(event);}},config:{logger:{info(){}}}};
 try{
  plugin.configureServer(server);
  for(let i=0;i<100&&!events.some(event=>event.data?.phase==='ready');i++)await new Promise(done=>setTimeout(done,10));
  assert.ok(events.some(event=>event.data?.phase==='error'));assert.ok(events.some(event=>event.data?.phase==='ready'));
  assert.equal(maxActive,1);assert.match(await readFile(join(root,config.output),'utf8'),/color: red/);
  let response='';handler({method:'GET'},{setHeader(){},end(value){response=value;}});
  assert.doesNotMatch(response,/fixture-secret|fixture-account|private.json/);
  let code;handler({method:'POST'},{writeHead(value){code=value;},end(){}});assert.equal(code,405);
  assert.match(plugin.transformIndexHtml('<body></body>'),/layout-status/);assert.equal(plugin.apply,'serve');
  await plugin.closeBundle();const stopped=attempts;await new Promise(done=>setTimeout(done,40));assert.equal(attempts,stopped);
 }finally{await plugin.closeBundle();}
});
