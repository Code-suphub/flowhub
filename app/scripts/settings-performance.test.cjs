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
