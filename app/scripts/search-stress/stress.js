const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
const makeRows=(n,long=false)=>Array.from({length:n},(_,i)=>({id:i+1,kind:'text',content:long&&i===0?'test '.repeat(28000):`synthetic record ${i} ${'text '.repeat(30)}`,hash:'0123456789abcdef',copyCount:1,lastSeenAt:'2026-09-07T00:00:00Z'}));
function seed(n,long=false) {allResultKeys=null;state.query='';state.clipboardResults=makeRows(n,long);state.appResults=[];state.memoResults=[];state.webResults=[];state.emptyResults={clipboard:state.clipboardResults.slice(0,30),app:[],web:[],memo:[]};for(const id of ['clipboard','app','web','memo']){state[id+'LoadedQuery']='';state[id+'HasMore']=false;} }
const baseRender=render; let milestones=null;
render=function(...args){const r=baseRender(...args);if(milestones&&document.querySelector('#results').textContent.includes('FAST_RESULT'))milestones.first??=performance.now();return r;};
document.querySelector('#runStress').onclick=async()=>{
 const report={engine:navigator.userAgent,scopes:[],reopen:[],slow:{}};
 for(const n of [30,300,1000,3000]){
  seed(n);const times=[];for(let i=0;i<5;i++){setScope('all');await frame();const t=performance.now();setScope('clipboard');const height=resultsEl.scrollHeight;times.push(performance.now()-t);await frame();}
  report.scopes.push({n,ms:times,domRows:resultsEl.querySelectorAll('.result').length,nodes:resultsEl.querySelectorAll('*').length});
  const t=performance.now();prepareForShow();resultsEl.scrollHeight;report.reopen.push({n,ms:performance.now()-t,rows:resultsEl.querySelectorAll('.result').length});
 }
 seed(30,true);setScope('all');await frame();let t=performance.now();setScope('clipboard');resultsEl.scrollHeight;report.longRecord={chars:140000,ms:performance.now()-t,domChars:resultsEl.textContent.length};
 for(const id of ['clipboard','app','web','memo']){seed(30);state.scope='all';await frame();const start=performance.now();setScope(id);resultsEl.scrollHeight;report.scopes.push({scope:id,n:30,ms:performance.now()-start});}
 seed(0);state.scope='all';state.query='FAST_RESULT';window.weborg.pluginSearch=async(id)=>{await new Promise(r=>setTimeout(r,id==='app'?900:20));return id==='clipboard'?[{...makeRows(1)[0],content:'FAST_RESULT'}]:[];};
 milestones={};t=performance.now();await refreshAllScopes();report.slow={firstResultMs:milestones.first-t,allCompleteMs:performance.now()-t};milestones=null;
 document.querySelector('#stressReport').textContent=JSON.stringify(report,null,2);
};
const flowButton=document.createElement('button');flowButton.textContent='Run paging checks';flowButton.style='position:fixed;left:4px;top:38px;z-index:9999';document.body.append(flowButton);
flowButton.onclick=async()=>{
 seed(3000);setScope('clipboard');await frame();resultsEl.scrollTop=resultsEl.scrollHeight;await frame();await frame();
 const atEnd=Number(resultsEl.querySelector('.result:last-of-type')?.dataset.i || [...resultsEl.querySelectorAll('.result')].at(-1)?.dataset.i);
 state.index=1200;revealActiveResult();await frame();const keyboardVisible=!!resultsEl.querySelector('.result[data-i="1200"]');
 resultsEl.scrollTop=0;await frame();await frame();const atStart=Number(resultsEl.querySelector('.result')?.dataset.i);
 seed(3000);setScope('all');let pages=0,maxDOM=0;const t=performance.now();
 while(allHasMore()&&pages<300){await loadMoreAll();pages++;maxDOM=Math.max(maxDOM,resultsEl.querySelectorAll('.result').length);if(pages%25===0)await frame();}
 const all=matches();const report={atEnd,atStart,keyboardVisible,pages,loaded:all.length,unique:new Set(all.map(resultKey)).size,maxDOM,totalMs:performance.now()-t};
 document.querySelector('#stressReport').textContent=JSON.stringify(report,null,2);
};
