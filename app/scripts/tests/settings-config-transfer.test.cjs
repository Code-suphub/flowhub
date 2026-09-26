const { test } = require('node:test'), assert = require('node:assert/strict');
const h = require('./settings-harness.test.cjs');
test('config import merge/replace scope preserves SQLite catalog and unknown plugin fields', () => {
 const current = h.fixture(), before = h.model.clone(current);
 const incoming = { scope:'all', config:{core:{hotkey:'Ctrl+Space'},plugins:{web:{enabled:false,settings:{}},clipboard:{enabled:false,settings:{retentionDays:7}}}} };
 const replaced = h.model.imported(current,incoming,'replace');
 assert.equal(replaced.core.hotkey,'Ctrl+Space'); assert.equal(replaced.plugins.clipboard.settings.retentionDays,7); assert.equal(replaced.plugins.clipboard.enabled,false);
 assert.equal(replaced.plugins.web.enabled,false); assert.deepEqual(replaced.plugins.web.settings.items,current.plugins.web.settings.items); assert.equal(replaced.plugins.web.settings.catalogStorage,'sqlite'); assert.deepEqual(current,before,'preview is pure');
 const merged=h.model.imported(current,{scope:'clipboard',config:{plugins:{clipboard:{settings:{retentionDays:3}}}}},'merge');
 assert.equal(merged.plugins.clipboard.settings.retentionDays,3); assert.equal(merged.plugins.clipboard.enabled,true); assert.deepEqual(merged.core,current.core); assert.deepEqual(merged.plugins.memo,current.plugins.memo);
 const core=h.model.imported(current,{scope:'core',config:{core:{hotkey:'F1'}}},'replace'); assert.equal(core.core.hotkey,'F1'); assert.deepEqual(core.plugins.memo,current.plugins.memo);
 assert.ok(h.model.diff(current,replaced).includes('core.hotkey'));
 assert.equal(h.model.merge({nested:{x:1},array:[1]},{nested:{y:2},array:[2]}).nested.x,1);
 assert.deepEqual(h.model.merge({array:[1]},{array:[2]}).array,[2]);
 assert.throws(()=>h.model.imported(current,{config:{core:null}},'replace'));
});
test('file import preview/cancel has no writes; applying is a reversible draft; export uses requested scope',async()=>{
 let exports=[]; const {store,writes}=await h.loaded({pickConfigImport:async()=>({path:'/mock/config.json',scope:'core',appVersion:'0.1',currentAppVersion:'0.2',config:{core:{hotkey:'F1'}}}),exportConfig:async scope=>{exports.push(scope);return {path:'/mock/export.json'};}});
 const {DataPanel}=require('../../src/settings/Core.tsx'), view=await h.mount(DataPanel,{store});
 await h.click(h.button(view.container,'导入配置…')); assert.match(document.body.textContent,/core.hotkey/); assert.match(document.body.textContent,/版本不同/); assert.equal(store.dirty,false); assert.equal(writes.length,0);
 await h.click(document.querySelector('[role="dialog"] [aria-label="关闭"]')); assert.equal(store.snapshot().config.core.hotkey,'Alt+Space');
 await h.click(h.button(view.container,'导入配置…')); await h.click(h.button(document.body,'应用为草稿')); assert.equal(store.snapshot().config.core.hotkey,'F1'); assert.equal(store.dirty,true); assert.equal(writes.length,0);
 await h.act(async()=>store.travel('undo')); assert.equal(store.snapshot().config.core.hotkey,'Alt+Space');
 await h.click(h.button(view.container,'导出配置…')); assert.deepEqual(exports,['all']);
 await view.unmount(); store.dispose();
});
