const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../ui/search.js'),'utf8');
const cut=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end));
async function main(){
  const q={focus(){},select(){}},state={scope:'app',index:0,usageColumn:0};
  let handler,items,calls=[],messages=[],prevented=0;
  const document={activeElement:q,documentElement:{dataset:{}},getElementById:()=>null,addEventListener:(name,fn)=>handler=fn};
  const context=vm.createContext({state,q,document,window:{weborg:{pluginAction:async(...args)=>{calls.push(args);return {ok:true};}}},
    searchInputComposing:false,searchCompositionEndedAt:0,performance:{now:()=>1000},scopeForShortcut:()=>null,
    scopeTabHeld:false,scopeTabUsedWithArrow:false,matches:()=>items,revealActiveResult(){},showActionStatus:m=>messages.push(m)});
  vm.runInContext(cut('function normalizeUrl(', 'function calculateExpression('),context);
  vm.runInContext(cut('function pathText(', 'function pageMatches('),context);
  vm.runInContext(cut('function usageIndices(', 'function clipboardTextHtml('),context);
  vm.runInContext(cut('function choose(', 'function queueDnsLookup('),context);
  vm.runInContext(cut('function returnToSearch()', 'document.addEventListener("keyup"'),context);
  const key=(name,extra={})=>handler({key:name,target:q,metaKey:false,ctrlKey:false,altKey:false,shiftKey:false,preventDefault(){prevented++;},...extra});
  for(const scope of ['all','app','web']){
    state.scope=scope;state.index=0;state.usageColumn=0;
    items=['A','B','C','D','E','F'].map((title,i)=>({type:'app',title,path:`/Applications/${title}.app`,...(i<3?{usageSection:'frequent'}:i<5?{usageSection:'recent'}:{})}));
    key('ArrowRight');assert.equal(state.index,1);
    key('ArrowRight');assert.equal(state.index,2);
    key('ArrowLeft');assert.equal(state.index,1);
    key('ArrowDown');assert.equal(state.index,4);
    key('ArrowUp');assert.equal(state.index,1);
    key('Enter');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.at(-1)[0],'app');assert.equal(calls.at(-1)[2].path,'/Applications/B.app');
  }
  for(const modifier of ['metaKey','ctrlKey','altKey','shiftKey']){
    state.index=0;const before=prevented;key('ArrowRight',{[modifier]:true});assert.equal(state.index,0);assert.equal(prevented,before);
  }
  items=[{type:'app',title:'Search result',path:'/Applications/A.app'}];state.index=0;
  const before=prevented;key('ArrowRight');assert.equal(prevented,before);
  context.searchInputComposing=true;key('Enter');assert.equal(calls.length,3);context.searchInputComposing=false;
  const app={type:'app',title:'A',path:'/Applications/A.app'};
  context.window.weborg.pluginAction=async()=>({ok:false,reason:'应用路径为空'});
  await context.choose(app);assert.equal(messages.at(-1),'应用路径为空');
  context.window.weborg.pluginAction=async()=>{throw 'Launch Services refused';};
  await context.choose(app);assert.equal(messages.at(-1),'Launch Services refused');
  context.window.weborg.pluginAction=()=>{throw new Error('native bridge failed');};
  await context.choose(app);assert.equal(messages.at(-1),'native bridge failed');
  const count=messages.length;context.window.weborg.pluginAction=async()=>({ok:false,cancelled:true});
  await context.choose(app);assert.equal(messages.length,count);
  console.log('PASS: usage arrows in all/app/web, row/column navigation, Enter target, editing modifiers, IME and launch error feedback');

  const listeners={},activated=[];let now=100,prevent=0;
  const row={dataset:{i:'0'}},otherRow={dataset:{i:'0'}};
  const mouse=vm.createContext({resultsEl:{addEventListener:(name,fn)=>listeners[name]=fn},matches:()=>[app],
    performance:{now:()=>now},choose:item=>activated.push(item.path),document:{documentElement:{dataset:{}}},window:{}});
  vm.runInContext(cut('let releasedAppPress', 'resultsEl.addEventListener("contextmenu"'),mouse);
  vm.runInContext(cut('resultsEl.addEventListener("click"', 'resultsEl.addEventListener("mousemove"'),mouse);
  const event=(stamp,target=row,button=0)=>({timeStamp:stamp,button,detail:1,target:{closest:selector=>selector==='.result'?target:null},preventDefault(){prevent++;}});
  listeners.mousedown(event(100));assert.equal(activated.length,0);assert.equal(prevent,1);
  listeners.mouseup(event(180));listeners.click(event(180));assert.equal(activated.length,1);
  now=500;listeners.mouseup(event(480));now=502;listeners.mousedown(event(400));assert.equal(activated.length,2);
  listeners.click(event(480));assert.equal(activated.length,2);
  listeners.mousedown(event(600));listeners.mouseup(event(680));listeners.click(event(680));assert.equal(activated.length,3);
  now=800;listeners.mouseup(event(780));now=1001;listeners.mousedown(event(700));assert.equal(activated.length,3);
  now=1100;listeners.mouseup(event(1080));listeners.mousedown(event(1000,otherRow));assert.equal(activated.length,3);
  app.type='clipboard';now=1200;listeners.mouseup(event(1180));listeners.mousedown(event(1100));assert.equal(activated.length,3);
  listeners.click({...event(1300),detail:0});assert.equal(activated.length,4);
  console.log('PASS: app click retains focus; reordered release/press launches once; ordinary clicks, keyboard clicks, stale/mismatched releases and clipboard isolation');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
