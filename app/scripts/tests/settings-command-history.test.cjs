const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');const h=require('./settings-harness.test.cjs');
test('command history defaults true, explicit false survives normalization and React switch edits a draft',async()=>{
 const {store}=await h.loaded();assert.equal(store.snapshot().config.plugins.tools.settings.commandHistory,true);
 const c=h.fixture();c.plugins.tools.settings.commandHistory=false;assert.equal(h.model.normalize(c).plugins.tools.settings.commandHistory,false);
 const {Tools}=require('../../src/settings/Core.tsx'),view=await h.mount(Tools,{store});await h.click(view.container.querySelector('[aria-label="命令历史"]'));assert.equal(store.snapshot().config.plugins.tools.settings.commandHistory,false);assert.equal(store.dirty,true);
 await h.click(view.container.querySelector('[aria-label="命令历史"]'));assert.equal(store.snapshot().config.plugins.tools.settings.commandHistory,true);await view.unmount();store.dispose();
});
test('history summary and clear use the real shared store for both history and templates',async()=>{
 const {store}=await h.loaded();vm.runInNewContext(h.fs.readFileSync(h.path.join(__dirname,'../../ui/shared/command-store.js'),'utf8'),{window,localStorage,console,URL});
 const command=window.FlowHubCommandStore;command.history.record('ping','ping example.com');command.history.record('ping','ping example.org');command.history.record('curl','curl https://example.com');command.templates.save('port',{query:'port 9000'});
 const {Tools}=require('../../src/settings/Core.tsx'),view=await h.mount(Tools,{store});assert.match(view.container.textContent,/3 条历史/);assert.match(view.container.textContent,/1 个模板/);
 await h.click(h.button(view.container,'清空历史与模板'));assert.equal(command.counts().total,3,'opening confirmation does not clear');await h.click(h.button(document.body,'确认清空'));assert.equal(command.counts().total,0);assert.equal(command.counts().templates,0);assert.match(view.container.textContent,/0 条历史/);await view.unmount();store.dispose();delete window.FlowHubCommandStore;
});
