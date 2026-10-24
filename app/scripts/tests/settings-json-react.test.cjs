const { test } = require('node:test'), assert = require('node:assert/strict');
const h = require('./settings-harness.test.cjs');
const { Settings } = require('../../src/settings/index.tsx');
const settle = () => h.act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
async function openMenu(view) {
 const trigger = view.container.querySelector('[aria-label="更多设置操作"]');
 await h.key(trigger, 'ArrowDown');
 assert.ok(document.querySelector('[role=menuitem]'), 'More menu opens');
}
test('global JSON action stays in the header across pages and cancelling malformed edits preserves the form',async()=>{
 const {store}=await h.loaded(),view=await h.mount(Settings,{store});
 assert.equal(view.container.querySelector('.settings-core-toolbar .fh-help'),null);assert.ok(view.container.querySelector('.settings-footer [aria-label="草稿与保存"] svg'));
 for(const page of ['网页目录','工具']){
  await h.click(h.button(view.container,page));assert.equal(view.container.querySelector('h1').textContent,`设置 / ${page}`);
  await openMenu(view);
  await h.click([...document.querySelectorAll('[role=menuitem]')].find(item=>item.textContent==='编辑完整配置 JSON'));
  assert.ok(document.querySelector('[role=dialog] [aria-label="完整配置 JSON"]'));
  await h.input(document.querySelector('[aria-label="完整配置 JSON"]'),'{ invalid');await h.click(h.button(document.body,'完成编辑'));assert.ok(document.querySelector('[role=dialog] [role=alert]'));
  await h.click(h.button(document.body,'取消编辑'));assert.equal(document.querySelector('[role=dialog]'),null);assert.equal(store.snapshot().jsonText,null);assert.equal(store.dirty,false);assert.equal(localStorage.length,0);assert.equal(store.snapshot().error,false);await settle();
 }
 await openMenu(view);await h.click([...document.querySelectorAll('[role=menuitem]')].find(item=>item.textContent==='编辑完整配置 JSON'));
 const config=h.model.clone(store.snapshot().config);config.core.launchAtLogin=true;await h.input(document.querySelector('[aria-label="完整配置 JSON"]'),JSON.stringify(config));await h.click(h.button(document.body,'完成编辑'));assert.equal(store.snapshot().config.core.launchAtLogin,true);assert.equal(store.dirty,true);await settle();
 await openMenu(view);await h.click([...document.querySelectorAll('[role=menuitem]')].find(item=>item.textContent==='版本与更新'));assert.equal(view.container.querySelector('#tab-updates').getAttribute('aria-selected'),'true');
 await view.unmount();await h.act(async()=>new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve))));store.dispose();
});
