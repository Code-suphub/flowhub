const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const bundle=fs.readFileSync(path.resolve(__dirname,'../../ui/react/host.js'),'utf8');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(predicate){for(let i=0;i<150;i++){if(predicate())return;await delay(10);}assert.ok(predicate(),'market did not settle');}
function setup(t,{count=80,installed=false,missing=false}={}) {
  const dom=new JSDOM('<div id="market-root"></div>',{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
  const state={epoch:0,catalog:Array.from({length:count},(_,i)=>({id:`tool-${i}`,name:`工具 ${String(i).padStart(2,'0')}`,version:'1.0',description:'键盘浏览测试',searchable:true})),installed:[]},calls=[],scrolls=[];
  if(installed)state.installed=state.catalog.map(manifest=>({manifest,directory:'/test/'+manifest.id,enabled:true}));
  if(missing)state.installed.push({manifest:{id:'offline',name:'离线插件',version:'1.0'},directory:'/test/offline',enabled:true});
  w.HTMLElement.prototype.scrollIntoView=function(){scrolls.push(this.dataset.marketKey);};w.scrollTo=()=>{};
  w.__TAURI__={core:{invoke:async(command,args)=>{
    calls.push({command,...args});
    if(command!=='plugin_api')throw Error('test does not open native plugins');
    switch(args.action){
      case 'list':return structuredClone(state.installed);
      case 'sources':return [{id:'local',name:'测试库',kind:'local',location:'/test',key:''}];
      case 'scanSource':return {plugins:state.catalog.map(manifest=>({manifest:{...manifest},source:'local',token:`${state.epoch}:${manifest.id}`})),warnings:[]};
      default:throw Error('test does not perform mutations');
    }
  }}};
  w.eval(bundle);t.after(()=>w.close());
  const cards=()=>[...w.document.querySelectorAll('[data-market-key]')];
  const button=(label,node=w.document)=>[...node.querySelectorAll('button,[role="menuitem"]')].find(el=>el.textContent===label);
  const key=(node,key,extra={})=>node.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
  const fill=value=>{const input=w.document.getElementById('market-query');Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const ready=async()=>{await wait(()=>cards().length && button('刷新插件') && !button('刷新插件').disabled);w.document.querySelector('.market-catalog-grid').style.gridTemplateColumns='1fr 1fr 1fr';};
  return {w,state,calls,scrolls,cards,button,key,fill,ready,search:()=>w.document.getElementById('market-query'),active:()=>w.document.activeElement};
}
test('grid navigation follows columns, keeps the preferred column, and never executes actions',async t=>{
  const s=setup(t,{count:8});await s.ready();s.search().focus();s.key(s.search(),'ArrowDown');await wait(()=>s.active()===s.cards()[0]);
  s.key(s.active(),'ArrowRight');await wait(()=>s.active()===s.cards()[1]);s.key(s.active(),'ArrowRight');await wait(()=>s.active()===s.cards()[2]);
  s.key(s.active(),'ArrowRight');assert.equal(s.active(),s.cards()[2],'right edge does not wrap');
  s.key(s.active(),'ArrowDown');assert.equal(s.active(),s.cards()[5]);s.key(s.active(),'ArrowDown');assert.equal(s.active(),s.cards()[7]);s.key(s.active(),'ArrowUp');assert.equal(s.active(),s.cards()[5]);
  s.search().focus();s.cards()[0].focus();s.key(s.active(),'ArrowDown');assert.equal(s.active(),s.cards()[3],'re-entering the grid starts from the actual column');
  s.cards()[3].dispatchEvent(new s.w.Event('pointerdown',{bubbles:true}));s.cards()[3].focus();s.key(s.active(),'ArrowDown');assert.equal(s.active(),s.cards()[6]);
  s.cards()[5].focus();
  s.w.document.querySelector('.market-catalog-grid').style.gridTemplateColumns='1fr';s.key(s.active(),'ArrowUp');assert.equal(s.active(),s.cards()[4]);
  s.key(s.active(),'Home');assert.equal(s.active(),s.cards()[0]);s.key(s.active(),'End');assert.equal(s.active(),s.cards()[7]);
  s.key(s.active(),'Escape');assert.equal(s.active(),s.search());assert.equal(s.calls.some(call=>!['list','sources','scanSource'].includes(call.action)),false);
});
test('roving card entry exposes only the current actions, while child controls and input own their keys',async t=>{
  const s=setup(t,{count:4,installed:true});await s.ready();s.search().focus();
  for(const extra of [{isComposing:true},{keyCode:229},{altKey:true},{ctrlKey:true},{metaKey:true},{shiftKey:true}]){s.key(s.search(),'ArrowDown',extra);assert.equal(s.active(),s.search());}
  s.key(s.search(),'ArrowLeft');assert.equal(s.active(),s.search());s.key(s.search(),'ArrowDown');await delay(10);
  assert.equal(s.cards().filter(card=>card.tabIndex===0).length,1);assert.ok([...s.cards()[1].querySelectorAll('button')].every(node=>node.tabIndex===-1));
  const title=s.cards()[0].querySelector('button');title.focus();s.key(title,'ArrowDown');assert.equal(s.active(),title);assert.equal(s.w.document.querySelector('[role="dialog"]'),null);
  const menu=s.cards()[0].querySelector('[aria-haspopup="menu"]');assert.notEqual(menu.tabIndex,-1);menu.click();await wait(()=>s.w.document.querySelector('[role="menu"]'));
  assert.equal(s.cards()[0].tabIndex,0);s.key(s.w.document.querySelector('[role="menuitem"]'),'Escape');await wait(()=>!s.w.document.querySelector('[role="menu"]'));
  s.cards()[0].focus();s.key(s.active(),'Enter',{isComposing:true});s.key(s.active(),'Enter',{repeat:true});assert.equal(s.w.document.querySelector('[role="dialog"]'),null);
});
test('keyboard and explicit pagination reveal a bounded next batch and focus its first new card',async t=>{
  const s=setup(t);await s.ready();s.cards()[0].focus();s.key(s.active(),'End');await wait(()=>s.active()===s.cards()[23]);
  s.key(s.active(),'ArrowDown');await wait(()=>s.cards().length===48 && s.active()===s.cards()[26]);
  s.key(s.active(),'PageDown');await wait(()=>s.cards().length===72 && s.active()===s.cards()[50]);
  s.key(s.active(),'PageUp');assert.equal(s.active(),s.cards()[26]);
  s.button('显示更多').click();await wait(()=>s.cards().length===80 && s.active()===s.cards()[72]);
  const key=s.active().dataset.marketKey;
  s.w.document.getElementById('tab-installed').click();await wait(()=>s.w.document.querySelector('.market-installed-list'));
  s.w.document.getElementById('tab-discover').click();await wait(()=>s.cards().length===80);assert.equal(s.cards().find(card=>card.tabIndex===0).dataset.marketKey,key);
  s.search().focus();s.fill('工具 79');await wait(()=>s.cards().length===1);assert.equal(s.active(),s.search());s.key(s.search(),'ArrowDown');assert.equal(s.active(),s.cards()[0]);
  s.key(s.active(),'Escape');s.fill('');await wait(()=>s.cards().length===80);assert.equal(s.calls.filter(call=>call.action==='scanSource').length,1);
});
test('details return to the same card across refreshed tokens and cancellation of install confirmation',async t=>{
  const s=setup(t,{count:40});await s.ready();s.button('显示更多').click();await wait(()=>s.cards().length===40);const origin=s.cards()[30];origin.focus();s.key(origin,'Enter');
  await wait(()=>s.w.document.querySelector('[role="dialog"]'));assert.match(s.w.document.querySelector('[role="dialog"]').textContent,/工具 30详情/);
  s.button('返回浏览').click();await wait(()=>!s.w.document.querySelector('[role="dialog"]') && s.active()===origin);assert.equal(s.cards().length,40);
  s.state.epoch++;s.button('刷新插件').click();await wait(()=>s.button('刷新插件') && !s.button('刷新插件').disabled);assert.equal(s.cards()[30],origin,'token refresh preserves the node');
  origin.focus();s.key(origin,'Enter');await wait(()=>s.button('安装插件'));s.button('安装插件').click();await wait(()=>s.button('确认'));s.button('取消').click();await wait(()=>!s.w.document.querySelector('[role="dialog"]') && s.active()===origin);
  assert.equal(s.calls.some(call=>call.action==='installCandidate'),false);
});
test('source changes preserve surviving identity and recover a removed target without stealing search focus',async t=>{
  const s=setup(t,{count:10});await s.ready();const old=s.cards()[5],key=old.dataset.marketKey;old.focus();
  s.state.catalog.unshift({id:'ahead',name:'A 工具',version:'1.0'});s.state.epoch++;s.button('刷新插件').click();await wait(()=>s.cards().length===11 && !s.button('刷新插件').disabled);
  assert.equal(s.cards().find(card=>card.dataset.marketKey===key),old);assert.equal(s.cards().find(card=>card.tabIndex===0),old);
  old.focus();s.state.catalog=s.state.catalog.filter(item=>item.id!=='tool-5');s.button('刷新插件').click();await wait(()=>s.cards().length===10 && !s.button('刷新插件').disabled);
  assert.ok(s.active().matches('[data-market-key]'),'removed focused item falls back to a card');
  s.search().focus();s.state.catalog=s.state.catalog.filter(item=>item.id!=='tool-6');s.button('刷新插件').click();await wait(()=>s.cards().length===9 && !s.button('刷新插件').disabled);assert.equal(s.active(),s.search());
});
test('installed rows use vertical navigation; Enter without a catalog only enters controls',async t=>{
  const s=setup(t,{count:3,installed:true,missing:true});await s.ready();s.w.document.getElementById('tab-installed').click();await wait(()=>s.cards().length===4);
  s.search().focus();s.key(s.search(),'ArrowDown');s.key(s.active(),'ArrowDown');assert.equal(s.active(),s.cards()[1]);s.key(s.active(),'Enter');await wait(()=>s.button('返回浏览'));s.button('返回浏览').click();await wait(()=>s.active()===s.cards()[1]);
  s.key(s.active(),'End');s.key(s.active(),'Enter');assert.equal(s.active().tagName,'SUMMARY');assert.equal(s.w.document.querySelector('[role="dialog"]'),null);
  assert.equal(s.calls.some(call=>!['list','sources','scanSource'].includes(call.action)),false);
});
test('manage from details focuses the matching installed row and no-result search stays usable',async t=>{
  const s=setup(t,{count:4,installed:true});await s.ready();s.cards()[2].focus();s.key(s.active(),'Enter');await wait(()=>s.button('管理插件'));s.button('管理插件').click();await wait(()=>s.cards().length===1 && s.active()===s.cards()[0]);
  assert.equal(s.active().getAttribute('aria-label'),'工具 02');s.key(s.active(),'Escape');s.fill('不存在');await wait(()=>s.cards().length===0);s.key(s.search(),'ArrowDown');assert.equal(s.active(),s.search());
  s.button('清除搜索与筛选').click();await wait(()=>s.cards().length===4);assert.equal(s.active(),s.search());
});
