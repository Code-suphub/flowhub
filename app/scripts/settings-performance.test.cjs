const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname, '../ui/settings.js'),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
let scan=0,fields=0,modules=0,navigation=0;let resolveTrust;
const state={module:'core',coreSection:'general',config:{core:{menuBar:{organizerEnabled:true}}}};
const ctx=vm.createContext({state,Promise,window:{weborg:{getMenuBarManagementState:()=>{scan++;return new Promise(r=>resolveTrust=r)},listMenuBarItems:async()=>({ok:true,items:[]})}},renderSettingsFields:()=>fields++,renderMenuBarItemControls:()=>{},renderModule:()=>modules++,renderPluginModules:()=>navigation++,document:{querySelector:()=>({scrollTo(){}})},toast:()=>{}});
vm.runInContext(extract('let menuBarRefreshPending','async function setMenuBarItemHidden')+extract('function switchModule(', '// Native disclosure'),ctx);
(async()=>{
 await ctx.refreshMenuBarManagementState();assert.equal(scan,0);
 state.coreSection='menubar';const a=ctx.refreshMenuBarManagementState(),b=ctx.refreshMenuBarManagementState();assert.equal(a,b);assert.equal(scan,1);resolveTrust({trusted:true});await a;assert.equal(fields,1);
 const c=ctx.refreshMenuBarManagementState();state.coreSection='general';resolveTrust({trusted:true});await c;assert.equal(fields,1);
 ctx.switchModule('memo');assert.equal(modules,1);assert.equal(navigation,0);ctx.switchModule('memo');assert.equal(modules,1);
 console.log('PASS: hidden-page scan skipped, overlapping refresh deduplicated, late hidden-page result does not rerender fields, module switch does not rebuild navigation, repeated selection is a no-op');
})().catch(e=>{console.error(e);process.exitCode=1});

// Each item belongs to one category; recursive rendering must not append it twice.
const memoState = { memoFilter: "", memoCollapsedCategories: new Set() };
const memoCtx = vm.createContext({
  state: memoState,
  memoCategorySegments: item => item.category.split(" / "),
  renderMemoListItem: item => `<item id="${item.id}"></item>`,
  esc: value => value,
});
vm.runInContext(extract('function memoTree(', 'function renderMemoListItem('), memoCtx);
const sampleMemos = [
  { id: 'parent', category: '编程' },
  { id: 'nested', category: '编程 / 数据库 / MySQL' },
  { id: 'sibling', category: '编程 / 数据库 / PostgreSQL' },
];
const memoMarkup = memoCtx.renderMemoTreeBranch(memoCtx.memoTree(sampleMemos));
for (const item of sampleMemos) assert.equal(memoMarkup.split(`<item id="${item.id}">`).length - 1, 1);
assert.equal(memoCtx.countMemoTreeItems(memoCtx.memoTree(sampleMemos)), 3);
assert.equal(memoCtx.renderMemoTreeBranch(memoCtx.memoTree([])), '');
console.log('PASS: nested and parent-category memos render once, counts match, empty tree stays empty');

assert.ok(memoMarkup.includes('编程 / 数据库 / MySQL'));
assert.ok(memoMarkup.includes('编程 / 数据库 / PostgreSQL'));
assert.equal((memoMarkup.match(/class="memo-tree-label"/g) || []).length, 4);
assert.equal((memoMarkup.match(/<strong>编程<\/strong>/g) || []).length, 1);
assert.equal((memoMarkup.match(/<strong>数据库<\/strong>/g) || []).length, 1);
assert.ok(memoMarkup.includes('<strong>编程</strong><small>3</small>'));
console.log('PASS: shared category ancestors merge, parent counts include descendants');

memoState.memoCollapsedCategories.add('编程 / 数据库 / MySQL');
const folded = memoCtx.renderMemoTreeBranch(memoCtx.memoTree(sampleMemos));
assert.ok(folded.includes('data-memo-category="编程 / 数据库 / MySQL" >'));
assert.ok(folded.includes('data-memo-category="编程 / 数据库 / PostgreSQL" open>'));
memoState.memoFilter = 'mysql';
assert.ok(memoCtx.renderMemoTreeBranch(memoCtx.memoTree(sampleMemos)).includes('data-memo-category="编程 / 数据库 / MySQL" open>'));
memoState.memoFilter = '';
assert.ok(memoCtx.renderMemoTreeBranch(memoCtx.memoTree(sampleMemos)).includes('data-memo-category="编程 / 数据库 / MySQL" >'));
console.log('PASS: independent category collapse, search expands groups, clearing search restores collapse');

memoState.memoCollapsedCategories.add('编程');
assert.ok(memoCtx.renderMemoTreeBranch(memoCtx.memoTree(sampleMemos)).includes('data-memo-category="编程" >'));
memoState.memoFilter = 'mysql';
const searching = memoCtx.renderMemoTreeBranch(memoCtx.memoTree(sampleMemos.filter(item => item.id === 'nested')));
for (const path of ['编程', '编程 / 数据库', '编程 / 数据库 / MySQL']) assert.ok(searching.includes(`data-memo-category="${path}" open>`));
assert.ok(!searching.includes('PostgreSQL'));
console.log('PASS: parent categories fold and matching search paths expand through all ancestors');
