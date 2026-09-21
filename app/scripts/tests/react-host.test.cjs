const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const bundle = fs.readFileSync(path.resolve(__dirname, '../../ui/react/host.js'), 'utf8');
const wait = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(predicate(), 'React state did not settle');
};
function setup(invoke, settings = false) {
  const dom = new JSDOM(`<div id="${settings ? 'settings-navigation-root' : 'market-root'}"></div>`, { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  if (invoke) w.__TAURI__ = { core: { invoke } };
  if (settings) {
    let section = 'general';
    w.FlowHubSettingsNavigation = { getSection: () => section, selectSection: value => { section = value; w.dispatchEvent(new w.Event('flowhub:settings-section')); } };
  }
  w.eval(bundle);
  const button = label => [...w.document.querySelectorAll('button')].find(el => el.textContent === label);
  return { dom, w, button };
}
const manifest = { id: 'test', name: '测试插件', version: '1.0', description: '用于回归测试' };
function backend(extra = {}) {
  const calls = [];
  return { calls, invoke: async (command, { action, payload }) => {
    calls.push({ command, action, payload });
    if (extra[action]) return extra[action](payload);
    if (action === 'list') return [{ manifest, directory: '/test/plugin', enabled: true }];
    if (action === 'sources') return [{ id: 'local', name: '测试来源', kind: 'local', location: '/test', key: '' }];
    if (action === 'scanSource') return { plugins: [{ manifest, token: 'candidate-token', source: 'local' }], warnings: [] };
    return null;
  } };
}
test('browser preview disables mutation but leaves navigation usable', async t => {
  const { dom, w, button } = setup(); t.after(() => dom.window.close());
  await wait(() => button('配置来源'));
  assert.equal(button('安装开发目录').disabled, true);
  button('配置来源').click(); await wait(() => button('添加来源'));
  assert.equal(button('添加来源').disabled, true);
  assert.match(w.document.body.textContent, /浏览器预览只读/);
});
test('scan and install require an explicit confirmation; cancel makes no install call', async t => {
  const mock = backend(); const { dom, w, button } = setup(mock.invoke); t.after(() => dom.window.close());
  await wait(() => button('刷新来源') && !button('刷新来源').disabled);
  button('刷新来源').click(); await wait(() => button('重新安装'));
  button('重新安装').click(); await wait(() => w.document.querySelector('dialog[open]'));
  assert.match(w.document.querySelector('dialog').textContent, /可访问当前用户文件和网络/);
  button('取消').click(); await wait(() => !w.document.querySelector('dialog'));
  assert.equal(mock.calls.some(c => c.action === 'installCandidate'), false);
  button('重新安装').click(); await wait(() => button('确认'));
  button('确认').click(); await wait(() => button('重新加载'));
  assert.deepEqual(mock.calls.find(c => c.action === 'installCandidate').payload.token, 'candidate-token');
});
test('source dialog save failure is visible inside the dialog and keeps input', async t => {
  const mock = backend({ saveSource: () => { throw new Error('来源无效'); } });
  const { dom, w, button } = setup(mock.invoke); t.after(() => dom.window.close());
  await wait(() => button('刷新来源') && !button('刷新来源').disabled);
  button('来源').click(); await wait(() => button('编辑')); button('编辑').click();
  await wait(() => w.document.querySelector('form'));
  w.document.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(() => w.document.querySelector('dialog [role="alert"]'));
  assert.match(w.document.querySelector('dialog [role="alert"]').textContent, /来源无效/);
  assert.equal(w.document.querySelector('dialog input').value, '测试来源');
});
test('busy operations cannot be submitted twice and uninstall is confirmed', async t => {
  let resolve; const mock = backend({ uninstall: () => new Promise(done => { resolve = done; }) });
  const { dom, w, button } = setup(mock.invoke); t.after(() => dom.window.close());
  await wait(() => button('刷新来源') && !button('刷新来源').disabled);
  button('已安装').click(); await wait(() => button('卸载')); button('卸载').click();
  await wait(() => button('确认')); button('确认').click(); button('确认').click();
  await wait(() => resolve);
  assert.equal(mock.calls.filter(c => c.action === 'uninstall').length, 1);
  resolve(); await wait(() => !w.document.querySelector('dialog'));
});
test('settings React navigation supports keyboard selection and external updates', async t => {
  const { dom, w, button } = setup(undefined, true); t.after(() => dom.window.close());
  await wait(() => button('基础'));
  button('基础').focus(); button('基础').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await wait(() => button('搜索入口').getAttribute('aria-selected') === 'true');
  assert.equal(w.document.activeElement, button('搜索入口'));
  w.FlowHubSettingsNavigation.selectSection('updates');
  await wait(() => button('更新').getAttribute('aria-selected') === 'true');
  assert.match(button('更新').dataset.helpTooltip, /版本/);
});
