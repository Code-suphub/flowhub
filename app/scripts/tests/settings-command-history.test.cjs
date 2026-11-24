const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');const h=require('./settings-harness.test.cjs');
test('command history defaults true, explicit false survives normalization and React switch edits a draft',async()=>{
 const {store}=await h.loaded();assert.equal(store.snapshot().config.plugins.tools.settings.commandHistory,true);
 const c=h.fixture();c.plugins.tools.settings.commandHistory=false;assert.equal(h.model.normalize(c).plugins.tools.settings.commandHistory,false);
 const {Tools}=require('../../src/settings/Tools.tsx'),view=await h.mount(Tools,{store});await h.click(view.container.querySelector('[aria-label="命令历史"]'));assert.equal(store.snapshot().config.plugins.tools.settings.commandHistory,false);assert.equal(store.dirty,true);
 await h.click(view.container.querySelector('[aria-label="命令历史"]'));assert.equal(store.snapshot().config.plugins.tools.settings.commandHistory,true);await view.unmount();store.dispose();
});
test('history summary and clear use the real shared store for both history and templates',async()=>{
 const {store}=await h.loaded();vm.runInNewContext(h.fs.readFileSync(h.path.join(__dirname,'../../ui/shared/command-store.js'),'utf8'),{window,localStorage,console,URL});
 const command=window.FlowHubCommandStore;command.history.record('ping','ping example.com');command.history.record('ping','ping example.org');command.history.record('curl','curl https://example.com');command.templates.save('port',{query:'port 9000'});
 const {Tools}=require('../../src/settings/Tools.tsx'),view=await h.mount(Tools,{store});assert.match(view.container.textContent,/3 条历史/);assert.match(view.container.textContent,/1 个模板/);
 await h.click(h.button(view.container,'清空历史与模板'));assert.equal(command.counts().total,3,'opening confirmation does not clear');await h.click(h.button(document.body,'确认清空'));assert.equal(command.counts().total,0);assert.equal(command.counts().templates,0);assert.match(view.container.textContent,/0 条历史/);await view.unmount();store.dispose();delete window.FlowHubCommandStore;
});
test('partial history clear reports remaining data and can retry without saving the config draft', async t => {
 const { Tools } = require('../../src/settings/Tools.tsx');
 const { store, writes } = await h.loaded();
 let counts = { total: 2, templates: 1 };
 let attempts = 0;
 window.FlowHubCommandStore = {
   counts: () => counts,
   clearAll() { counts = { total: 0, templates: ++attempts === 1 ? 1 : 0 }; },
 };
 const view = await h.mount(Tools, { store });
 t.after(async () => { await view.unmount(); store.dispose(); delete window.FlowHubCommandStore; });
 await h.click(view.container.querySelector('[aria-label="命令历史"]'));
 await h.click(h.button(view.container, '清空历史与模板'));
 await h.click(h.button(document.body, '确认清空'));
 assert.match(document.querySelector('[role="dialog"] [role="alert"]').textContent, /未清空/);
 assert.match(view.container.textContent, /0 条历史 · 1 个模板/);
 await h.click(h.button(document.body, '确认清空'));
 assert.equal(document.querySelector('[role="dialog"]'), null);
 assert.equal(h.button(view.container, '清空历史与模板').disabled, true);
 assert.equal(store.snapshot().config.plugins.tools.settings.commandHistory, false);
 assert.equal(store.dirty, true);
 assert.equal(writes.length, 0);
});
