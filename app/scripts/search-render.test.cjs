const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const s=fs.readFileSync(require('node:path').join(__dirname,'../ui/search.js'),'utf8');
let top=120,events=[];
const resultsEl={get scrollTop(){return top},set scrollTop(v){top=v;events.push('scroll')},set innerHTML(v){events.push('dom')}};
const ctx=vm.createContext({window:{},state:{config:{},scope:'clipboard',clipboardLoading:false,clipboardHasMore:false},resultsEl,matches:()=>[{}],renderResults:()=>'<div>row</div>',lastResultsHtml:'',windowedResults:false,esc:s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;')});
vm.runInContext(s.slice(s.indexOf('function renderMeasured('),s.indexOf('function revealActiveResult(')),ctx);
ctx.renderMeasured({preserveScroll:true});assert.deepEqual(events,['dom']);assert.equal(top,120);
events=[];ctx.lastResultsHtml='';ctx.renderMeasured();assert.deepEqual(events,['scroll','dom']);assert.equal(top,0);
vm.runInContext(s.slice(s.indexOf('function clipboardTextHtml('),s.indexOf('function isExpandableClipboard(')),ctx);
const original='<script>❌✅';const html=ctx.clipboardTextHtml(original);
assert(!html.includes('<script>'));assert.equal((html.match(/<svg/g)||[]).length,2);assert(html.includes('aria-label="❌"'));assert.equal(original,'<script>❌✅');
console.log('PASS: preserved scroll avoids post-DOM writes, reset precedes DOM, status preview escapes content and preserves source');
const content='<script>\n'+'content line\n'.repeat(100);
let expandedClass=false,aria,buttonText;
const title={innerHTML:'',scrollTop:0,classList:{toggle(name,value){expandedClass=value}}};
const row={querySelector:()=>title,getBoundingClientRect:()=>({height:expandedClass?280:100})};
const button={dataset:{clipboardToggle:'7'},closest:()=>row,setAttribute(name,value){aria=value},set textContent(v){buttonText=v}};
ctx.state.clipboardResults=[{id:7,kind:'text',content}];ctx.state.expandedClipboard=new Set();ctx.resultWindow={heights:new Map()};ctx.resultKey=item=>`${item.type}:${item.id}`;ctx.getComputedStyle=()=>({marginTop:'0',marginBottom:'4'});
events=[];top=800;
ctx.toggleClipboardPreview(button);assert.equal(top,800);assert.deepEqual(events,[]);assert.equal(aria,'true');assert(expandedClass);assert(title.innerHTML.includes('&lt;script>'));assert.equal(ctx.resultWindow.heights.get('clipboard:7'),284);
ctx.toggleClipboardPreview(button);assert.equal(top,800);assert.equal(aria,'false');assert(!expandedClass);assert(title.innerHTML.length<content.length);assert.equal(ctx.resultWindow.heights.get('clipboard:7'),104);assert(buttonText.includes('展开'));
assert(s.includes('toggleClipboardPreview(toggle);'));
console.log('PASS: expand/collapse patches current row, keeps outer scroll, updates ARIA and virtual height, escapes full text');
// Reopening must reconcile cached clipboard rows, even if the pending event's
// debounce was cancelled. Updates in other scopes must remain marked stale.
let updateHandler, refreshed=0;
const showState={emptyResults:{clipboard:[],app:[],web:[],memo:[]},scope:'app'};
const show=vm.createContext({window:{weborg:{onClipboardUpdated:fn=>updateHandler=fn},FlowHubTools:{queryChanged(){}}},state:showState,
  q:{value:'old'},resultsEl:{scrollTop:99},allResultKeys:['old'],allInitialResults:['old'],allScopeRefreshToken:0,
  clipboardSearchTimer:null,dnsSearchTimer:null,proxySearchTimer:null,dnsSearchToken:0,proxySearchToken:0,
  CLIPBOARD_PAGE_SIZE:30,clearTimeout(){},toolContext(){},render(){},focusSearch(){},
  invalidateClipboardPaging(){},invalidatePluginPaging(){},queueClipboardRefresh(){},refreshClipboard(){refreshed++}});
vm.runInContext(s.slice(s.indexOf('window.weborg.onClipboardUpdated('),s.indexOf('});',s.indexOf('window.weborg.onClipboardUpdated('))+3),show);
updateHandler();assert.equal(showState.clipboardLoadedQuery,null);assert.equal(show.allResultKeys,null);
vm.runInContext(s.slice(s.indexOf('function prepareForShow()'),s.indexOf('window.focusSearch =')),show);
show.prepareForShow();assert.equal(refreshed,1);assert.equal(showState.clipboardLoadedQuery,null);assert.equal(showState.query,'');
console.log('PASS: clipboard events invalidate inactive scopes and paged keys; show reconciles storage after cached paint');
// Cold native replies must not undo a scroll made while metadata/assets load.
(async () => {
  let resolveQuery, resolveAssets, scroll = 0;
  const coldState = { scope: 'clipboard', query: '', clipboardKind: 'all', clipboardResults: [], emptyResults: {} };
  const cold = vm.createContext({ state: coldState, clipboardSearchToken: 0, CLIPBOARD_PAGE_SIZE: 30,
    pluginEnabled: () => true,
    window: { weborg: {
      pluginSearch: () => new Promise(resolve => { resolveQuery = resolve; }),
      loadClipboardAssets: () => new Promise(resolve => { resolveAssets = resolve; })
    } },
    render(options) { if (!options?.preserveScroll) scroll = 0; }
  });
  vm.runInContext(s.slice(s.indexOf('async function refreshClipboard('), s.indexOf('async function refreshApps(')), cold);
  const query = cold.refreshClipboard();
  scroll = 180;
  resolveQuery([{ id: 1, kind: 'image' }]);
  await query;
  assert.equal(scroll, 180, 'late first-page query must preserve scrolling');
  scroll = 360;
  resolveAssets({ '1': { imageUrl: 'data:image/png;base64,fixture' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scroll, 360, 'cold asset completion must preserve scrolling');
  assert(coldState.clipboardResults[0].imageUrl);
  const stale = cold.hydrateClipboardAssets([{ id: 1, kind: 'image' }], cold.clipboardSearchToken);
  cold.clipboardSearchToken++;
  coldState.clipboardResults = [{ id: 2, kind: 'text' }];
  resolveAssets({ '1': { imageUrl: 'stale' } });
  await stale;
  assert.equal(coldState.clipboardResults[0].id, 2);
  assert.equal(scroll, 360);
  console.log('PASS: cold clipboard query/assets preserve user scroll; stale assets cannot publish');
})().catch(error => { console.error(error); process.exitCode = 1; });
