const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const bundle=fs.readFileSync(path.resolve(__dirname,'../../ui/react/host.js'),'utf8');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await delay(10);}assert.ok(predicate(),'React state did not settle');};
const manifest={id:'test',name:'测试插件',version:'1.0',description:'用于回归测试',searchable:true};
const fresh={id:'fresh',name:'新插件',version:'1.1',description:'第二个插件'};
const source={id:'local',name:'测试来源',kind:'local',location:'/test',key:''};
function setup(t,invoke) {
  const dom=new JSDOM('<div id="market-root"></div>',{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;w.HTMLElement.prototype.scrollIntoView=function(){};w.scrollTo=()=>{};
  if(invoke)w.__TAURI__={core:{invoke}};
  w.eval(bundle);t.after(()=>dom.window.close());
  const button=(label,node=w.document)=>[...node.querySelectorAll('button,[role="menuitem"]')].find(el=>el.textContent===label);
  const tab=id=>w.document.getElementById('tab-'+id);
  const article=name=>[...w.document.querySelectorAll('article')].find(el=>el.getAttribute('aria-label')===name);
  const fill=(input,value)=>{Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new w.Event('input',{bubbles:true}));};
  return {w,button,tab,article,fill};
}
function backend(extra={},initial={}) {
  const calls=[],state={plugins:[{manifest,directory:'/test/plugin',enabled:true}],sources:[source],catalog:[manifest,fresh],epoch:0,...initial};
  const copy=value=>JSON.parse(JSON.stringify(value));
  return {calls,state,invoke:async(command,{action,payload})=>{
    calls.push({command,action,payload});if(extra[action])return extra[action](payload,state);
    switch(action){
      case 'list':return copy(state.plugins);
      case 'sources':return copy(state.sources);
      case 'scanSource':return {plugins:state.catalog.map(item=>({manifest:copy(item),token:`${payload.id}:${state.epoch}:${item.id}`,source:payload.id})),warnings:[]};
      case 'installCandidate':{assert.ok(payload.token.includes(`:${state.epoch}:`),'candidate must belong to current source configuration');const item=state.catalog.find(item=>payload.token.endsWith(':'+item.id));state.plugins=[...state.plugins.filter(plugin=>plugin.manifest.id!==item.id),{manifest:item,directory:'/test/'+item.id,enabled:true}];return null;}
      case 'enable':state.plugins=state.plugins.map(item=>item.manifest.id===payload.id?{...item,enabled:payload.enabled}:item);return null;
      case 'uninstall':state.plugins=state.plugins.filter(item=>item.manifest.id!==payload.id);return null;
      case 'saveSource':state.epoch++;state.sources=[...state.sources.filter(item=>item.id!==payload.id),{...payload,id:payload.id||'new-source'}];return copy(state.sources);
      case 'removeSource':state.epoch++;state.sources=state.sources.filter(item=>item.id!==payload.id);return copy(state.sources);
      default:return null;
    }
  }};
}
async function ready(ui){await wait(()=>ui.w.document.querySelectorAll('.market-catalog-card').length && ui.button('刷新插件') && !ui.button('刷新插件').disabled);}

test('browser preview exposes two tabs and read-only source settings without mutation controls',async t=>{
  const ui=setup(t);await wait(()=>ui.tab('installed'));
  assert.equal(ui.w.document.querySelectorAll('[role="tab"]').length,2);assert.equal(ui.tab('sources'),null);
  assert.equal(ui.w.document.querySelector('[aria-label="插件市场更多操作"]'),null);
  ui.button('来源设置').click();await wait(()=>ui.w.document.querySelector('[role="dialog"]'));
  assert.equal(ui.button('添加来源'),undefined);assert.match(ui.w.document.querySelector('[role="dialog"]').textContent,/请在桌面 App 添加来源/);
});
test('first visit reads configured sources automatically and distinguishes installed plugins',async t=>{
  const mock=backend({}, {plugins:[{manifest,directory:'/test/plugin',enabled:true},{manifest:{id:'another',name:'其他工具',version:'1.0'},directory:'/test/another',enabled:true}]}),ui=setup(t,mock.invoke);await ready(ui);
  assert.equal(mock.calls.filter(call=>call.action==='scanSource').length,1);
  assert.ok(ui.button('管理',ui.article(manifest.name)));assert.ok(ui.button('安装',ui.article(fresh.name)));
  ui.button('管理',ui.article(manifest.name)).click();await wait(()=>ui.tab('installed').getAttribute('aria-selected')==='true');
  assert.equal(ui.w.document.querySelector('#market-query').value,manifest.name);assert.equal(ui.w.document.querySelectorAll('.market-installed-row').length,1);
  assert.match(ui.w.document.querySelector('.market-results-heading').textContent,/1 个插件 · 1 个已启用/,'filtered counts describe the visible plugins');
});
test('empty native market opens the source form in one action',async t=>{
  const mock=backend({}, {sources:[]}),ui=setup(t,mock.invoke);await wait(()=>ui.button('添加来源'));
  ui.button('添加来源').click();await wait(()=>ui.w.document.querySelector('form[aria-label="添加来源"]'));
  assert.ok(ui.w.document.querySelector('#source-name'));assert.equal(mock.calls.some(call=>call.action==='saveSource'),false);
});
test('install is explicit, cancellation makes no call and confirmation installs the captured token once',async t=>{
  const mock=backend(),ui=setup(t,mock.invoke);await ready(ui);
  ui.button('安装',ui.article(fresh.name)).click();await wait(()=>ui.w.document.querySelector('[role="dialog"]'));
  assert.match(ui.w.document.querySelector('[role="dialog"]').textContent,/可访问当前用户文件和网络/);
  ui.button('取消').click();await wait(()=>!ui.w.document.querySelector('[role="dialog"]'));
  assert.equal(mock.calls.some(call=>call.action==='installCandidate'),false);
  ui.button('安装',ui.article(fresh.name)).click();await wait(()=>ui.button('确认'));ui.button('确认').click();ui.button('确认').click();
  await wait(()=>ui.w.document.querySelectorAll('.market-installed-row').length===2);
  assert.equal(mock.calls.filter(call=>call.action==='installCandidate').length,1);assert.equal(mock.calls.find(call=>call.action==='installCandidate').payload.token,'local:0:fresh');
});
test('same-version reinstallation remains an explicit advanced action',async t=>{
  const mock=backend(),ui=setup(t,mock.invoke);await ready(ui);
  assert.equal(ui.button('重新安装'),undefined);
  ui.w.document.querySelector('[aria-label="更多测试插件操作"]').click();await wait(()=>ui.button('重新安装此版本'));ui.button('重新安装此版本').click();
  await wait(()=>ui.button('确认'));assert.match(ui.w.document.querySelector('[role="dialog"]').textContent,/当前已安装 v1.0/);
  assert.equal(mock.calls.some(call=>call.action==='installCandidate'),false);ui.button('取消').click();
  await wait(()=>!ui.w.document.querySelector('[role="dialog"]'));assert.equal(mock.calls.some(call=>call.action==='installCandidate'),false);
});
test('installation rejection remains visible in the confirmation without reporting success',async t=>{
  const mock=backend({installCandidate:()=>{throw Error('安装包签名无效');}}),ui=setup(t,mock.invoke);await ready(ui);
  ui.button('安装',ui.article(fresh.name)).click();await wait(()=>ui.button('确认'));ui.button('确认').click();
  await wait(()=>ui.w.document.querySelector('[role="dialog"]')?.textContent.includes('安装包签名无效'));
  assert.match(ui.w.document.querySelector('[role="dialog"]').textContent,/安装包签名无效/);assert.equal(mock.state.plugins.length,1);
});
test('source form failure preserves input and exposes the error beside the form',async t=>{
  const mock=backend({saveSource:()=>{throw Error('来源无效');}}),ui=setup(t,mock.invoke);await ready(ui);
  ui.button('来源设置').click();await wait(()=>ui.button('编辑'));ui.button('编辑').click();await wait(()=>ui.w.document.querySelector('form'));
  const form=ui.w.document.querySelector('form');assert.equal(form.querySelectorAll('[data-slot="field-group"]').length,1);assert.equal(form.querySelectorAll('[role="radio"]').length,2);
  form.dispatchEvent(new ui.w.Event('submit',{bubbles:true,cancelable:true}));await wait(()=>form.querySelector('[role="alert"]'));
  assert.match(form.querySelector('[role="alert"]').textContent,/来源无效/);assert.equal(form.querySelector('#source-name').value,'测试来源');
});
test('HTTPS source fields remain explicitly labeled and require a signing key',async t=>{
  const ui=setup(t,backend().invoke);await ready(ui);ui.button('来源设置').click();await wait(()=>ui.button('编辑'));ui.button('编辑').click();await wait(()=>ui.w.document.querySelector('#source-kind-https'));
  ui.w.document.querySelector('#source-kind-https').click();await wait(()=>ui.w.document.querySelector('#source-key'));
  assert.equal(ui.w.document.querySelector('#source-location').labels[0].textContent,'仓库索引地址');assert.equal(ui.w.document.querySelector('#source-key').labels[0].textContent,'仓库签名公钥');assert.equal(ui.w.document.querySelector('#source-key').required,true);
});
test('saving a source refreshes every candidate token before any later installation',async t=>{
  const mock=backend({}, {sources:[source,{...source,id:'other',name:'另一来源'}]}),ui=setup(t,mock.invoke);await ready(ui);
  ui.button('来源设置').click();await wait(()=>ui.button('编辑'));ui.button('编辑').click();await wait(()=>ui.w.document.querySelector('form'));
  ui.w.document.querySelector('form').dispatchEvent(new ui.w.Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>!ui.w.document.querySelector('form') && mock.calls.filter(call=>call.action==='scanSource').length===4);
  ui.w.document.querySelector('[aria-label="关闭"]').click();await wait(()=>!ui.w.document.querySelector('[role="dialog"]'));
  const card=[...ui.w.document.querySelectorAll('.market-catalog-card')].find(card=>card.textContent.includes('另一来源')&&card.getAttribute('aria-label')===fresh.name);
  ui.button('安装',card).click();await wait(()=>ui.button('确认'));ui.button('确认').click();await wait(()=>mock.calls.some(call=>call.action==='installCandidate'));
  assert.equal(mock.calls.find(call=>call.action==='installCandidate').payload.token,'other:1:fresh');
});
test('removing a source is confirmed, rescans remaining sources and retains installed plugins',async t=>{
  const mock=backend({}, {sources:[source,{...source,id:'other',name:'另一来源'}]}),ui=setup(t,mock.invoke);await ready(ui);
  ui.button('来源设置').click();await wait(()=>ui.button('移除'));ui.button('移除').click();assert.equal(mock.calls.some(call=>call.action==='removeSource'),false);
  await wait(()=>ui.button('确认移除'));ui.button('确认移除').click();await wait(()=>mock.state.sources.length===1 && !ui.button('确认移除'));
  assert.equal(mock.state.plugins.length,1);assert.equal(mock.calls.some(call=>call.action==='uninstall'),false);assert.equal(mock.calls.filter(call=>call.action==='scanSource'&&call.payload.id==='other').length,2);
});
test('one failed source preserves successful results and explains the issue in source settings',async t=>{
  const mock=backend({scanSource:({id})=>{if(id==='other')throw Error('无法连接插件库');return {plugins:[{manifest:fresh,token:'ok',source:id}],warnings:[]};}},{sources:[source,{...source,id:'other',name:'另一来源'}]}),ui=setup(t,mock.invoke);
  await ready(ui);assert.equal(ui.w.document.querySelectorAll('.market-catalog-card').length,1);assert.match(ui.w.document.body.textContent,/1 个来源需要处理/);
  ui.button('查看来源问题').click();await wait(()=>ui.w.document.querySelector('.market-source-error'));assert.match(ui.w.document.querySelector('.market-source-error').textContent,/无法连接插件库/);
});
test('a late source response keeps the selected view and search query',async t=>{
  let resolve;const mock=backend({scanSource:()=>new Promise(done=>{resolve=done;})}),ui=setup(t,mock.invoke);
  await wait(()=>resolve);ui.tab('installed').click();await wait(()=>ui.tab('installed').getAttribute('aria-selected')==='true');
  ui.fill(ui.w.document.querySelector('#market-query'),'保留关键词');await delay(10);resolve({plugins:[],warnings:[]});await wait(()=>ui.w.document.querySelector('.fh-market').getAttribute('aria-busy')==='false');
  assert.equal(ui.tab('installed').getAttribute('aria-selected'),'true');assert.equal(ui.w.document.querySelector('#market-query').value,'保留关键词');
});
test('uninstall requires confirmation and pending operations cannot be submitted twice',async t=>{
  let resolve;const mock=backend({uninstall:()=>new Promise(done=>{resolve=done;})}),ui=setup(t,mock.invoke);await ready(ui);
  ui.tab('installed').click();await wait(()=>ui.w.document.querySelector('[aria-label="管理测试插件"]'));ui.w.document.querySelector('[aria-label="管理测试插件"]').click();await wait(()=>ui.button('卸载插件'));ui.button('卸载插件').click();
  await wait(()=>ui.button('确认'));ui.button('确认').click();ui.button('确认').click();await wait(()=>resolve);assert.equal(mock.calls.filter(call=>call.action==='uninstall').length,1);
  resolve();await wait(()=>!ui.w.document.querySelector('[role="dialog"]'));
});
test('large catalogs render bounded pages and filtering does not rescan sources',async t=>{
  const mock=backend({}, {plugins:[],catalog:Array.from({length:80},(_,i)=>({id:'tool-'+i,name:'工具 '+i,version:'1.0'}))}),ui=setup(t,mock.invoke);await ready(ui);
  assert.equal(ui.w.document.querySelectorAll('.market-catalog-card').length,24);ui.button('显示更多').click();await wait(()=>ui.w.document.querySelectorAll('.market-catalog-card').length===48);
  ui.fill(ui.w.document.querySelector('#market-query'),'工具 79');await wait(()=>ui.w.document.querySelectorAll('.market-catalog-card').length===1);
  assert.equal(ui.w.document.querySelector('.market-catalog-card').getAttribute('aria-label'),'工具 79');assert.equal(mock.calls.filter(call=>call.action==='scanSource').length,1);
});
test('an install completed in the background cannot leave a delayed focus request for later actions',async t=>{
  let finish;
  const mock=backend({installCandidate:(_,state)=>new Promise(resolve=>{finish=()=>{state.plugins.push({manifest:fresh,directory:'/test/fresh',enabled:true});resolve(null);};})}),ui=setup(t,mock.invoke);await ready(ui);
  Object.defineProperty(ui.w.document,'hasFocus',{configurable:true,value:()=>false});
  ui.button('安装',ui.article(fresh.name)).click();await wait(()=>ui.button('确认'));ui.button('确认').click();await wait(()=>finish);finish();
  await wait(()=>!ui.w.document.querySelector('[role="dialog"]'));await delay(30);
  Object.defineProperty(ui.w.document,'hasFocus',{configurable:true,value:()=>true});
  ui.tab('discover').click();await wait(()=>ui.tab('discover').getAttribute('aria-selected')==='true');
  const search=ui.w.document.querySelector('#market-query');ui.fill(search,'新插件');search.focus();
  ui.button('刷新插件').click();await wait(()=>ui.button('刷新插件') && !ui.button('刷新插件').disabled);await delay(30);
  assert.ok(ui.w.document.activeElement===search,'later source reads must not move focus to an old install target');
  assert.equal(ui.tab('discover').getAttribute('aria-selected'),'true');
});
