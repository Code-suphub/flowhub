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
      case 'installCandidate':{assert.ok(payload.token.includes(`:${state.epoch}:`),'candidate must belong to current source configuration');const item=state.catalog.find(item=>payload.token.endsWith(':'+item.id)),previous=state.plugins.find(plugin=>plugin.manifest.id===item.id);state.plugins=[...state.plugins.filter(plugin=>plugin.manifest.id!==item.id),{manifest:item,directory:'/test/'+item.id,enabled:previous?.enabled??true}];return null;}
      case 'enable':state.plugins=state.plugins.map(item=>item.manifest.id===payload.id?{...item,enabled:payload.enabled}:item);return null;
      case 'uninstall':state.plugins=state.plugins.filter(item=>item.manifest.id!==payload.id);return null;
      case 'saveSource':{state.epoch++;const id=payload.id||'source:'+payload.location;state.sources=[...state.sources.filter(item=>item.id!==id),{...payload,id}];return copy(state.sources);}
      case 'removeSource':state.epoch++;state.sources=state.sources.filter(item=>item.id!==payload.id);return copy(state.sources);
      default:return null;
    }
  }};
}
async function ready(ui){await wait(()=>ui.w.document.querySelectorAll('.market-catalog-card').length && ui.button('刷新插件') && !ui.button('刷新插件').disabled);}
async function choose(ui,label,value){ui.w.document.querySelector(`[aria-label="${label}"]`).click();await wait(()=>[...ui.w.document.querySelectorAll('[role="option"]')].some(item=>item.textContent===value));[...ui.w.document.querySelectorAll('[role="option"]')].find(item=>item.textContent===value).click();await delay(10);}

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
test('system monitor install confirmation discloses the privileged read-only service before any installation',async t=>{
  const monitor={...fresh,permissions:['native-process','system-process-monitor']};
  const mock=backend({}, {catalog:[manifest,monitor]}),ui=setup(t,mock.invoke);await ready(ui);
  ui.button('安装',ui.article(monitor.name)).click();await wait(()=>ui.button('确认'));
  const detail=ui.w.document.querySelector('[role="dialog"]').textContent;
  for(const disclosure of [/root 身份/,/所有用户进程/,/UID/,/父进程/,/内存足迹/,/CPU 时间/,/不读取命令行或环境变量/,/不能结束进程/,/macOS 会请求管理员认证/])assert.match(detail,disclosure);
  assert.equal(mock.calls.some(call=>call.action==='installCandidate'),false);
  ui.button('取消').click();await wait(()=>!ui.w.document.querySelector('[role="dialog"]'));
  assert.equal(mock.calls.some(call=>call.action==='installCandidate'),false);
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
  await choose(ui,'按来源筛选','另一来源');
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

test('official catalog connects only on request, adds one pinned aggregate source once and installs nothing',async t=>{
  const mock=backend({}, {sources:[]}),ui=setup(t,mock.invoke);await wait(()=>ui.button('连接官方库') && !ui.button('连接官方库').disabled);
  assert.equal(mock.calls.some(call=>call.action==='saveSource'),false);
  ui.button('连接官方库').click();ui.button('连接官方库').click();await ready(ui);
  const saves=mock.calls.filter(call=>call.action==='saveSource');
  assert.equal(saves.length,1);assert.equal(saves[0].payload.location,'https://api.github.com/repos/Code-suphub/flowhub-plugins/releases?per_page=100');
  assert.ok(saves.every(call=>call.payload.key==='RWQIJOnosHIl5QGJ83XSe/Mx8aIvANKnnSUDpzVVNxCAZjTR+cBm1Jne'));
  assert.equal(ui.button('连接官方库'),undefined);assert.equal(mock.calls.some(call=>['install','installCandidate'].includes(call.action)),false);
  assert.equal(mock.calls.filter(call=>call.action==='scanSource').length,1);
});
test('connecting the aggregate catalog preserves custom and legacy fixed-version sources',async t=>{
  const existing={id:'official-existing',name:'我的设备来源',kind:'https',location:'https://github.com/Code-suphub/flowhub-plugins/releases/download/device-center-v0.2.7/catalog.json',key:'untrusted comment: public key\nRWQIJOnosHIl5QGJ83XSe/Mx8aIvANKnnSUDpzVVNxCAZjTR+cBm1Jne\n'};
  const mock=backend({}, {sources:[source,existing]}),ui=setup(t,mock.invoke);await ready(ui);
  ui.button('连接官方库').click();await wait(()=>mock.calls.filter(call=>call.action==='saveSource').length===1 && ui.button('刷新插件') && !ui.button('刷新插件').disabled);
  assert.deepEqual(mock.state.sources.find(item=>item.id===source.id),source);assert.deepEqual(mock.state.sources.find(item=>item.id===existing.id),existing);
  assert.equal(mock.state.sources.length,3);assert.equal(mock.calls.filter(call=>call.action==='scanSource'&&call.payload.id==='local').length,2);
});
test('a conflicting aggregate URL never replaces a custom key and existing sources remain usable',async t=>{
  const conflict={id:'conflict',name:'自定义签名来源',kind:'https',location:'https://api.github.com/repos/Code-suphub/flowhub-plugins/releases?per_page=100',key:'custom-key'};
  const mock=backend({}, {sources:[source,conflict]}),ui=setup(t,mock.invoke);await ready(ui);ui.button('连接官方库').click();
  await wait(()=>ui.w.document.querySelector('[role="alert"]')?.textContent.includes('不同公钥') && !ui.button('刷新插件').disabled);
  assert.deepEqual(mock.state.sources.find(item=>item.id==='conflict'),conflict);assert.equal(mock.calls.filter(call=>call.action==='saveSource').length,0);
  assert.equal(mock.state.sources.length,2);assert.ok(ui.article(fresh.name));
  ui.button('安装',ui.article(fresh.name)).click();await wait(()=>ui.button('确认'));ui.button('确认').click();await wait(()=>mock.calls.some(call=>call.action==='installCandidate'));
  assert.equal(mock.calls.find(call=>call.action==='installCandidate').payload.token,'local:0:fresh');
});
test('a failed aggregate save retains existing sources and retry connects without duplicating them',async t=>{
  let fail=true;
  const mock=backend({saveSource:(payload,state)=>{
    if(fail)throw Error('保存失败');
    state.epoch++;state.sources.push({...payload,id:'saved:'+payload.location});return JSON.parse(JSON.stringify(state.sources));
  }},{sources:[source]}),ui=setup(t,mock.invoke);await ready(ui);ui.button('连接官方库').click();
  await wait(()=>ui.w.document.querySelector('[role="alert"]')?.textContent.includes('保存失败') && !ui.button('刷新插件').disabled);
  assert.equal(mock.state.sources.length,1);assert.equal(mock.calls.filter(call=>call.action==='scanSource'&&call.payload.id==='local').length,2);
  fail=false;ui.button('连接官方库').click();await wait(()=>!ui.button('连接官方库') && !ui.button('刷新插件').disabled);
  assert.equal(mock.calls.filter(call=>call.action==='saveSource').length,2);assert.equal(mock.state.sources.length,2);
});
test('plugin details expose full metadata without installing and continue through the explicit confirmation',async t=>{
  const long={...fresh,description:'完整说明。'.repeat(120),permissions:['native-process'],widget:{}};
  const mock=backend({}, {catalog:[long]}),ui=setup(t,mock.invoke);await ready(ui);
  ui.w.document.querySelector('[aria-label="查看新插件详情"]').click();await wait(()=>ui.button('返回浏览'));
  const detail=ui.w.document.querySelector('[role="dialog"]');assert.ok(detail.textContent.includes(long.description));assert.match(detail.textContent,/可安装版本|native-process|当前用户文件和网络/);
  assert.equal(mock.calls.some(call=>call.action==='installCandidate'),false);
  ui.button('安装插件').click();await wait(()=>ui.button('确认'));assert.equal(ui.w.document.querySelectorAll('[role="dialog"]').length,1);
  assert.match(ui.w.document.querySelector('[role="dialog"]').textContent,/来源：测试来源/);ui.button('取消').click();
  await wait(()=>!ui.w.document.querySelector('[role="dialog"]'));assert.equal(mock.calls.some(call=>call.action==='installCandidate'),false);
});
test('capability and source filters combine in memory and reset without another catalog request',async t=>{
  const mock=backend({scanSource:({id})=>({plugins:(id==='local'?[manifest,{...fresh,widget:{}}]:[{...fresh,id:'other-tool',name:'其他组件',widget:{}}]).map(manifest=>({manifest,source:id,token:manifest.id})),warnings:[]})},{sources:[source,{...source,id:'other',name:'其他库'}]}),ui=setup(t,mock.invoke);await ready(ui);
  const choose=async(label,value)=>{ui.w.document.querySelector(`[aria-label="${label}"]`).click();await wait(()=>[...ui.w.document.querySelectorAll('[role="option"]')].some(item=>item.textContent===value));[...ui.w.document.querySelectorAll('[role="option"]')].find(item=>item.textContent===value).click();};
  await choose('按功能筛选','桌面组件');await wait(()=>ui.w.document.querySelectorAll('.market-catalog-card').length===2);
  await choose('按来源筛选','其他库');await wait(()=>ui.w.document.querySelectorAll('.market-catalog-card').length===1);
  assert.equal(ui.w.document.querySelector('.market-catalog-card').getAttribute('aria-label'),'其他组件');
  ui.fill(ui.w.document.querySelector('#market-query'),'找不到');await wait(()=>ui.button('清除搜索与筛选'));ui.button('清除搜索与筛选').click();
  await wait(()=>ui.w.document.querySelectorAll('.market-catalog-card').length===3);assert.equal(mock.calls.filter(call=>call.action==='scanSource').length,2);
});

test('semantic versions distinguish updates, downgrades, build metadata and prereleases',()=>{
  const ts=require('typescript'),module={exports:{}};
  const code=ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../../src/market/versions.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('exports','require','module',code)(module.exports,require,module);
  const {compareVersions,installLabel,availableUpdates}=module.exports;
  for(const [a,b,value] of [['0.10.0','0.9.0',1],['1.0.0-beta.10','1.0.0-beta.2',1],['1.0.0','1.0.0-rc.1',1],['1.0.0+build2','1.0.0+build1',0],['1.0.0','2.0.0',-1],['bad','1.0.0',null],['1.0.0-01','1.0.0',null]])assert.equal(compareVersions(a,b),value);
  const plugin={manifest:{...manifest,version:'0.9.0'}};
  assert.equal(installLabel({manifest:{...manifest,version:'0.8.0'}},plugin),'回退版本');
  assert.equal(installLabel({manifest:{...manifest,version:'1.0.0-beta.1'}},plugin),'更换版本');
  const updates=availableUpdates([plugin],[{manifest:{...manifest,version:'0.10.0'}},{manifest:{...manifest,version:'0.9.1'}},{manifest:{...manifest,version:'1.0.0-beta.1'}}]);
  assert.equal(updates.get('test').manifest.version,'0.10.0');
});
test('installed updates choose the highest stable version, preserve disabled state and require confirmation',async t=>{
  const mock=backend({}, {plugins:[{manifest:{...manifest,version:'0.9.0'},directory:'/test/old',enabled:false}],catalog:[{...manifest,version:'0.10.0'},fresh]}),ui=setup(t,mock.invoke);await ready(ui);
  ui.tab('installed').click();await wait(()=>ui.button('更新'));await choose(ui,'安装状态筛选','可更新 (1)');
  assert.equal(ui.w.document.querySelectorAll('.market-installed-row').length,1);ui.button('更新').click();await wait(()=>ui.button('确认'));
  assert.match(ui.w.document.querySelector('[role="dialog"]').textContent,/更新插件.*当前已安装 v0.9.0/s);ui.button('取消').click();await wait(()=>!ui.w.document.querySelector('[role="dialog"]'));
  assert.equal(mock.state.plugins[0].manifest.version,'0.9.0');ui.button('更新').click();await wait(()=>ui.button('确认'));ui.button('确认').click();
  await wait(()=>mock.state.plugins[0].manifest.version==='0.10.0' && !ui.w.document.querySelector('[role="dialog"]'));
  assert.equal(mock.state.plugins[0].enabled,false);assert.ok(ui.button('启用'));assert.equal(ui.button('打开 测试插件'),undefined);
});
test('native progress is visible, failed downloads retain the old installation and retry has no late progress listener',async t=>{
  let attempt=0,finish,channel;
  const mock=backend({installCandidate:payload=>{attempt++;channel=payload.onProgress;channel.onmessage({phase:'downloading',received:5*1024*1024,total:10*1024*1024});return new Promise((resolve,reject)=>{finish=()=>attempt===1?reject(Error('下载中断')):resolve(null);});}}),ui=setup(t,mock.invoke);await ready(ui);
  ui.w.__TAURI__.core.Channel=class{onmessage=()=>{}};
  ui.button('安装',ui.article(fresh.name)).click();await wait(()=>ui.button('确认'));ui.button('确认').click();await wait(()=>finish && ui.w.document.querySelector('[role="progressbar"]'));
  assert.equal(ui.w.document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'),'50');assert.match(ui.w.document.querySelector('[role="dialog"]').textContent,/5.0 MB \/ 10.0 MB/);
  assert.equal(ui.button('取消').disabled,true);finish();await wait(()=>ui.button('重试安装'));
  assert.equal(mock.state.plugins.length,1);assert.equal(ui.w.document.querySelector('[role="progressbar"]'),null);
  ui.button('重试安装').click();await wait(()=>attempt===2);finish();await wait(()=>!ui.w.document.querySelector('[role="dialog"]'));
  channel.onmessage({phase:'downloading',received:1,total:100});await delay(20);assert.equal(ui.w.document.querySelector('[role="progressbar"]'),null);
});
test('a completed install followed by a refresh failure does not offer installation again',async t=>{
  let installed=false;
  const mock=backend({installCandidate:()=>{installed=true;return null;},list:(_,state)=>{if(installed)throw Error('列表读取失败');return state.plugins;}}),ui=setup(t,mock.invoke);await ready(ui);
  ui.button('安装',ui.article(fresh.name)).click();await wait(()=>ui.button('确认'));ui.button('确认').click();await wait(()=>ui.w.document.querySelector('[role="alert"]')?.textContent.includes('操作已完成'));
  assert.equal(ui.w.document.querySelector('[role="dialog"]'),null);assert.equal(ui.button('重试安装'),undefined);assert.ok(ui.button('重新加载列表'));assert.equal(mock.calls.filter(call=>call.action==='installCandidate').length,1);
});
test('installed open uses native workspace selection and release notes render as text',async t=>{
  const mock=backend({scanSource:({id})=>({plugins:[{manifest,source:id,token:'notes',target:'macos-x86_64',releaseNotes:'<img src=x onerror=alert(1)>\n版本修复',publishedAt:'2026-10-30T12:00:00Z'}],warnings:[]})}),ui=setup(t,mock.invoke);await ready(ui);
  ui.w.document.querySelector('[aria-label="查看测试插件详情"]').click();await wait(()=>ui.button('返回浏览'));
  assert.match(ui.w.document.querySelector('[role="dialog"]').textContent,/macOS · Intel/);assert.equal(ui.w.document.querySelector('[role="dialog"] img'),null);assert.match(ui.w.document.querySelector('.market-release-notes').textContent,/<img/);
  ui.button('返回浏览').click();await wait(()=>!ui.w.document.querySelector('[role="dialog"]'));ui.tab('installed').click();await wait(()=>ui.button('打开'));ui.button('打开').click();await wait(()=>mock.calls.some(call=>call.command==='plugin_workspace'));
  assert.equal(mock.calls.find(call=>call.command==='plugin_workspace').action,'select');
});
test('an incomplete update check stays visible in the installed view and offers source repair',async t=>{
  let fail=false;const mock=backend({scanSource:({id})=>{if(fail)throw Error('来源离线');return {plugins:[{manifest,source:id,token:'ok'}],warnings:[]};}}),ui=setup(t,mock.invoke);await ready(ui);
  ui.tab('installed').click();await wait(()=>ui.button('检查更新'));fail=true;ui.button('检查更新').click();await wait(()=>ui.button('查看来源问题'));
  assert.match(ui.w.document.body.textContent,/部分来源未完成检查/);ui.button('查看来源问题').click();await wait(()=>ui.w.document.querySelector('[role="dialog"]'));
  assert.match(ui.w.document.querySelector('[role="dialog"]').textContent,/来源离线/);
});
