const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../ui/search/search.js'), 'utf8');
const state = { scope: 'all', query: 'flow', config: {} };
const ctx = vm.createContext({
  state, pluginEnabled: () => true,
  clipboardMatches: () => [{ type: 'clipboard', id: 'clip' }],
  appMatches: () => [{ type: 'app', id: 'app' }],
  pageMatches: () => [{ id: 'web' }], memoMatches: () => [],
  usageMatches: () => [], toolSuggestions: () => [], webAddSuggestion: () => null,
  usageKey: item=>`${item.type}:${item.id}`,
  withoutUsageDuplicates: (items) => items,
});
vm.runInContext(source.slice(source.indexOf('let allResultKeys'), source.indexOf('function moveVertical')), ctx);
const types = () => Array.from(ctx.matches(), item => item.type);
assert.deepEqual(types(), ['app', 'page', 'clipboard']);
state.config = { core: { webBeforeClipboard: false } };
assert.deepEqual(types(), ['app', 'clipboard', 'page']);
assert.deepEqual(Array.from(ctx.allCandidates(), item => item.type), ['app', 'clipboard', 'page']);
state.query = '';
assert.deepEqual(types(), ['clipboard', 'app', 'page']);
state.scope = 'clipboard';
assert.deepEqual(types(), ['clipboard']);
state.scope = 'app';
assert.deepEqual(types(), ['app']);
state.scope = 'web';
assert.deepEqual(types(), ['page']);
state.scope = 'all';
state.query = 'flow';
ctx.toolSuggestions = () => [{ type: 'tool' }];
assert.equal(types()[0], 'tool');
vm.runInContext(source.slice(source.indexOf('function setConfig('), source.indexOf('function eventMatchesShortcut')), ctx);
vm.runInContext("allResultKeys = ['app:app']; allInitialResults = [{type:'app',id:'app'}]", ctx);
ctx.setConfig({ core: { webBeforeClipboard: true } });
assert.deepEqual(types(), ['tool', 'app', 'page', 'clipboard']);
vm.runInContext(source.slice(source.indexOf('function usageMatches('), source.indexOf('function withoutUsageDuplicates')), ctx);
state.query = '';
state.usageSections = { frequent: [{ type: 'page', id: 'p' }, { type: 'app', id: 'a' }], recent: [] };
assert.deepEqual(Array.from(ctx.usageMatches(), item => item.type), ['page', 'app']);
state.usageSections.recent=[{type:'page',id:'p'},{type:'page',id:'recent-page'},{type:'page',id:'recent-page'}];
assert.deepEqual(Array.from(ctx.usageMatches(),item=>[item.usageSection,item.id]),[['frequent','p'],['frequent','a'],['recent','p'],['recent','recent-page']]);
state.scope='app';assert.deepEqual(Array.from(ctx.usageMatches(),item=>item.id),['a']);
state.scope='web';assert.deepEqual(Array.from(ctx.usageMatches(),item=>item.id),['p','p','recent-page']);
state.scope='all';state.usageSections.recent=[];
ctx.setConfig({ core: { searchResultOrder: ['memo', 'clipboard', 'web', 'app'] } });
ctx.memoMatches = () => [{type:'memo', id:'memo'}];
state.query = 'flow';
assert.deepEqual(types(), ['tool', 'memo', 'clipboard', 'page', 'app']);
assert.deepEqual(Array.from(ctx.allCandidates(), item => item.type), ['memo', 'clipboard', 'page', 'app']);
state.query = '';
assert.deepEqual(Array.from(ctx.usageMatches(), item => item.type), ['page', 'app']);
state.usageSections = {};
assert.deepEqual(types(), ['clipboard', 'app', 'page', 'memo']);
assert.deepEqual(Array.from(ctx.configuredSearchOrder({core:{searchResultOrder:['web','web','unknown']}})), ['web','app','clipboard','memo']);
assert.deepEqual(Array.from(ctx.configuredSearchOrder({core:{searchResultOrder:'invalid'}})), ['app','web','clipboard','memo']);
const settings = fs.readFileSync(require('node:path').join(__dirname, '../../src/settings/Core.tsx'), 'utf8');
const settingsContext = vm.createContext({});
// Keep the cross-entry ordering contract against the migrated settings logic.
const ordering = settings.slice(settings.indexOf('const savedOrder ='), settings.indexOf('const [previewOrder'));
assert.ok(ordering.includes('searchResultOrder'));
const settingsOrder = require('typescript').transpile(`function configuredSearchOrder(config) { const core = config.core || {}, c = {plugins: config.plugins || {}}, s = {plugins: []}; ${ordering} return order; }`, {target:99});
vm.runInContext(settingsOrder, settingsContext);
for (const config of [{}, state.config, {core:{webBeforeClipboard:false}}, {core:{searchResultOrder:['web','web','bad']}}, {core:{searchResultOrder:['twofa','memo','app']},plugins:{twofa:{enabled:true}}}]) {
  assert.deepEqual(Array.from(settingsContext.configuredSearchOrder(config)), Array.from(ctx.configuredSearchOrder(config)));
}
console.log('PASS search order: default, opt-out, pagination, empty query, individual scopes, explicit tools');

require('node:test')('usage refresh invalidates pending all-scope pages without clearing newer paging',async()=>{
  const pending=[];
  const selectedState={scope:'all',query:'',config:{},index:0,usageSections:{frequent:[{type:'app',id:'a'}],recent:[{type:'app',id:'a'}]},appLoadedQuery:'',appHasMore:true};
  const paging=vm.createContext({state:selectedState,allScopeRefreshToken:0,usageSearchToken:0,
    pluginEnabled:id=>id==='app',appMatches:()=>[{type:'app',id:'a'}],pageMatches:()=>[],clipboardMatches:()=>[],memoMatches:()=>[],twofaMatches:()=>[],
    toolSuggestions:()=>[],webAddSuggestion:()=>null,render:()=>{},
    refreshApps:()=>new Promise(resolve=>pending.push(resolve)),window:{weborg:{searchUsage:async()=>({frequent:[],recent:[{type:'app',id:'r'}]})}}});
  vm.runInContext(source.slice(source.indexOf('function usageKey('),source.indexOf('function moveVertical')),paging);
  vm.runInContext(source.slice(source.indexOf('async function refreshUsage('),source.indexOf('async function refreshAllScopes(')),paging);
  const old=paging.loadMoreAll();assert.equal(pending.length,1);
  assert.deepEqual(Array.from(paging.matches().filter(item=>item.usageSection),item=>item.usageSection),['frequent','recent'],'same app remains visible in both groups during pagination');
  await paging.refreshUsage();
  assert.equal(vm.runInContext('allResultKeys',paging),null);assert.equal(vm.runInContext('allPaging',paging),false);
  const current=paging.loadMoreAll();assert.equal(pending.length,2);
  pending[0]();await old;
  assert.equal(vm.runInContext('allPaging',paging),true,'old completion must not release the newer paging reservation');
  assert.deepEqual(Array.from(paging.matches().filter(item=>item.usageSection),item=>item.id),['r']);
  pending[1]();await current;assert.equal(vm.runInContext('allPaging',paging),false);
});

require('node:test')('all-scope usage budget reserves space for both rows and source filtering keeps groups',()=>{
  const state={scope:'all',query:'',config:{},usageSections:{frequent:Array.from({length:9},(_,id)=>({type:'app',id:`a${id}`})),recent:[{type:'app',id:'a0'},{type:'page',id:'w'}]}};
  const ctx=vm.createContext({state,pluginEnabled:()=>true,appMatches:()=>[],pageMatches:()=>[],clipboardMatches:()=>[],memoMatches:()=>[],twofaMatches:()=>[],toolSuggestions:()=>[],webAddSuggestion:()=>null});
  vm.runInContext(source.slice(source.indexOf('function usageKey('),source.indexOf('function moveVertical')),ctx);
  assert.deepEqual(Array.from(ctx.matches().filter(item=>item.usageSection),item=>item.usageSection),['frequent','frequent','frequent','frequent','recent','recent']);
  state.scope='app';assert.equal(ctx.matches().filter(item=>item.usageSection==='frequent').length,9);assert.equal(ctx.matches().filter(item=>item.usageSection==='recent').length,1);
  state.scope='web';assert.deepEqual(Array.from(ctx.matches(),item=>item.id),['w']);
});
