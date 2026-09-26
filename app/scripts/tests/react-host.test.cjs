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
function setup(invoke) {
  const dom = new JSDOM('<div id="market-root"></div>', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  if (invoke) w.__TAURI__ = { core: { invoke } };
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
  assert.equal(w.document.querySelector('[data-slot="empty-title"]')?.textContent, '还没有插件来源');
  assert.match(w.document.body.textContent, /浏览器预览只读/);
});
test('scan and install require an explicit confirmation; cancel makes no install call', async t => {
  const mock = backend(); const { dom, w, button } = setup(mock.invoke); t.after(() => dom.window.close());
  await wait(() => button('刷新来源') && !button('刷新来源').disabled);
  button('刷新来源').click(); await wait(() => button('重新安装'));
  button('重新安装').click(); await wait(() => w.document.querySelector('[role="dialog"]'));
  assert.match(w.document.querySelector('[role="dialog"]').textContent, /可访问当前用户文件和网络/);
  assert.equal(w.document.querySelector('[role="dialog"] [data-slot="alert-title"]')?.textContent, '运行权限提醒');
  button('取消').click(); await wait(() => !w.document.querySelector('[role="dialog"]'));
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
  const form = w.document.querySelector('form');
  assert.equal(form.querySelectorAll('[data-slot="field-group"]').length, 1);
  assert.equal(form.querySelectorAll('[data-slot="field"]').length, 2);
  assert.equal(form.querySelectorAll('[role="radio"]').length, 2);
  assert.equal(form.querySelector('input').labels[0].textContent, '名称');
  assert.equal(form.querySelector('#source-location').labels[0].textContent, '目录');
  w.document.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(() => w.document.querySelector('[role="dialog"] [role="alert"]'));
  assert.match(w.document.querySelector('[role="dialog"] [role="alert"]').textContent, /来源无效/);
  assert.equal(w.document.querySelector('[role="dialog"] input').value, '测试来源');
});
test('source form labels the HTTPS location and signing key', async t => {
  const mock = backend(); const { dom, w, button } = setup(mock.invoke); t.after(() => dom.window.close());
  await wait(() => button('刷新来源') && !button('刷新来源').disabled);
  button('来源').click(); await wait(() => button('编辑')); button('编辑').click();
  await wait(() => w.document.querySelector('#source-location'));
  w.document.querySelector('#source-kind-https').click();
  await wait(() => w.document.querySelector('#source-key'));
  assert.equal(w.document.querySelector('#source-location').labels[0].textContent, '仓库索引地址');
  assert.equal(w.document.querySelector('#source-key').labels[0].textContent, '仓库签名公钥');
});
test('busy operations cannot be submitted twice and uninstall is confirmed', async t => {
  let resolve; const mock = backend({ uninstall: () => new Promise(done => { resolve = done; }) });
  const { dom, w, button } = setup(mock.invoke); t.after(() => dom.window.close());
  await wait(() => button('刷新来源') && !button('刷新来源').disabled);
  button('已安装').click(); await wait(() => button('卸载')); button('卸载').click();
  await wait(() => button('确认')); button('确认').click(); button('确认').click();
  await wait(() => resolve);
  assert.equal(mock.calls.filter(c => c.action === 'uninstall').length, 1);
  resolve(); await wait(() => !w.document.querySelector('[role="dialog"]'));
});
