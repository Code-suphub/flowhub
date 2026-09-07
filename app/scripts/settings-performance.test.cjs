const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname, '../ui/settings.js'),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
let scan=0,fields=0,modules=0,navigation=0;let resolveTrust;
const state={module:'core',coreSection:'general',config:{core:{menuBar:{organizerEnabled:true}}}};
const ctx=vm.createContext({state,Promise,window:{weborg:{getMenuBarManagementState:()=>{scan++;return new Promise(r=>resolveTrust=r)},listMenuBarItems:async()=>({ok:true,items:[]})}},renderSettingsFields:()=>fields++,renderMenuBarItemControls:()=>{},renderModule:()=>modules++,renderPluginModules:()=>navigation++,document:{querySelector:()=>({scrollTo(){}})},toast:()=>{}});
vm.runInContext(extract('let menuBarRefreshPending','async function setMenuBarItemHidden')+extract('function switchModule(', 'document.addEventListener("click"'),ctx);
(async()=>{
 await ctx.refreshMenuBarManagementState();assert.equal(scan,0);
 state.coreSection='menubar';const a=ctx.refreshMenuBarManagementState(),b=ctx.refreshMenuBarManagementState();assert.equal(a,b);assert.equal(scan,1);resolveTrust({trusted:true});await a;assert.equal(fields,1);
 const c=ctx.refreshMenuBarManagementState();state.coreSection='general';resolveTrust({trusted:true});await c;assert.equal(fields,1);
 ctx.switchModule('memo');assert.equal(modules,1);assert.equal(navigation,0);ctx.switchModule('memo');assert.equal(modules,1);
 console.log('PASS: hidden-page scan skipped, overlapping refresh deduplicated, late hidden-page result does not rerender fields, module switch does not rebuild navigation, repeated selection is a no-op');
})().catch(e=>{console.error(e);process.exitCode=1});

// Each item belongs to one category; recursive rendering must not append it twice.
const memoCtx = vm.createContext({
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
