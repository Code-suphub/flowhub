const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setup, wait, delay } = require('./search-react-harness.cjs');

const dialog = s => s.w.document.querySelector('[role="dialog"]');
const button = (s, label) => [...s.w.document.querySelectorAll('[role="dialog"] button')]
  .find(node => node.textContent === label);
const actions = s => s.calls.filter(call => call[0] === 'action');
const searches = s => s.calls.filter(call => call[0] === 'search' && call[1] === 'clipboard').length;
async function open(s) {
  s.q.focus();
  s.key('Backspace', { altKey: true });
  await wait(() => dialog(s));
}
function cancelEvent(s) {
  dialog(s).dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

test('clipboard delete: cancel button, close button and Escape never dispatch deletion', async t => {
  const s = await setup(t);
  await s.scope('clipboard');
  for (const cancel of [
    () => button(s, '取消').click(),
    () => dialog(s).querySelector('[aria-label="关闭"]').click(),
    () => cancelEvent(s),
  ]) {
    await open(s);
    assert.equal(s.w.document.activeElement, button(s, '取消'));
    assert.equal(button(s, '确认删除').type, 'button');
    cancel();
    await wait(() => !dialog(s));
    assert.equal(actions(s).length, 0);
    assert.ok(s.w.document.querySelector('.clipboard-result'));
  }
});

test('clipboard delete: explicit confirmation sends the captured id once and locks cancellation while pending', async t => {
  const s = await setup(t);
  await s.scope('clipboard');
  let complete;
  s.w.weborg.pluginAction = (...args) => {
    s.calls.push(['action', ...args]);
    return new Promise(resolve => { complete = resolve; });
  };
  await open(s);
  const before = searches(s);
  const confirm = button(s, '确认删除');
  confirm.click();
  confirm.click();
  await wait(() => dialog(s)?.getAttribute('aria-busy') === 'true');
  assert.equal(actions(s).length, 1);
  assert.deepEqual(Array.from(actions(s)[0].slice(1, 3)), ['clipboard', 'delete']);
  assert.equal(actions(s)[0][3].id, 1);
  assert.equal(actions(s)[0][3].confirmed, true);
  assert.ok([...dialog(s).querySelectorAll('button')].every(node => node.disabled));
  cancelEvent(s);
  await delay(20);
  assert.ok(dialog(s));
  assert.equal(searches(s), before);
  complete({ ok: true });
  await wait(() => !dialog(s) && searches(s) > before);
  assert.equal(actions(s).length, 1);
  assert.match(s.w.document.querySelector('#actionStatus').textContent, /已删除/);
});

for (const rejected of [false, true]) {
  test(`clipboard delete: ${rejected ? 'rejected promise' : 'negative result'} retains row and exposes an error`, async t => {
    const s = await setup(t);
    await s.scope('clipboard');
    s.w.weborg.pluginAction = async (...args) => {
      s.calls.push(['action', ...args]);
      if (rejected) throw new Error('fixture transport failure');
      return { ok: false, reason: 'fixture delete refused' };
    };
    await open(s);
    const before = searches(s);
    button(s, '确认删除').click();
    await wait(() => dialog(s)?.querySelector('[role="alert"]'));
    assert.match(dialog(s).querySelector('[role="alert"]').textContent,
      rejected ? /删除失败/ : /fixture delete refused/);
    assert.match(s.w.document.querySelector('#actionStatus').textContent,
      rejected ? /fixture transport failure/ : /fixture delete refused/);
    assert.ok(s.w.document.querySelector('.clipboard-result'));
    assert.equal(searches(s), before, 'Failed deletion must not refresh as success');
    assert.equal(button(s, '确认删除').disabled, false);
    button(s, '取消').click();
    await wait(() => !dialog(s));
    assert.equal(actions(s).length, 1, 'Cancellation after failure must not retry');
  });
}

test('clipboard delete: read-only shortcuts/context menu and read-only change before confirmation send no action', async t => {
  const preview = await setup(t, { readonly: true });
  await preview.scope('clipboard');
  preview.q.focus();
  preview.key('Delete', { altKey: true });
  preview.w.document.querySelector('.clipboard-result').dispatchEvent(
    new preview.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await delay(20);
  assert.equal(dialog(preview), null);
  assert.equal(actions(preview).length, 0);

  const s = await setup(t);
  await s.scope('clipboard');
  await open(s);
  s.w.document.documentElement.dataset.weborgReadonly = 'true';
  button(s, '确认删除').click();
  await wait(() => dialog(s)?.querySelector('[role="alert"]'));
  assert.match(dialog(s).textContent, /浏览器预览不能修改剪贴板/);
  assert.equal(actions(s).length, 0);
  assert.ok(s.w.document.querySelector('.clipboard-result'));
});

test('clipboard delete: modal keyboard events do not run search actions, navigate scopes or hide the window', async t => {
  const s = await setup(t);
  await s.scope('clipboard');
  await open(s);
  const initialCalls = s.calls.length;
  const selected = s.q.getAttribute('aria-activedescendant');
  // JSDOM does not emulate native Enter activation or Tab traversal.
  // These events verify the application's keydown isolation only.
  for (const [key, extra] of [
    ['Enter', {}], ['Enter', { shiftKey: true }],
    ['Delete', { altKey: true }], ['d', { metaKey: true }],
    ['e', { metaKey: true }], ['k', { metaKey: true }],
    ['F6', {}], ['ArrowDown', {}], ['Tab', {}],
  ]) {
    button(s, '取消').dispatchEvent(new s.w.KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...extra,
    }));
  }
  button(s, '取消').dispatchEvent(new s.w.KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));
  await delay(20);
  assert.equal(s.calls.length, initialCalls);
  assert.equal(s.q.getAttribute('aria-activedescendant'), selected);
  assert.equal(s.w.document.querySelector('[data-scope][aria-pressed="true"]').dataset.scope, 'clipboard');
  assert.equal(s.w.document.activeElement, button(s, '取消'));
  assert.ok(dialog(s));
});

test('clipboard delete adapter: exact confirmed flag, writable mode and valid target are required before native invoke', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../ui/shared/tauri-adapter.js'), 'utf8');
  const start = source.indexOf('  async function pluginAction(');
  const end = source.indexOf('  window.weborg =', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const document = { documentElement: { dataset: {} } };
  const context = vm.createContext({
    document, usageListeners: [],
    window: { confirm() { assert.fail('Legacy native confirmation must not be used'); } },
    invoke: async (...args) => { calls.push(args); return { ok: true }; },
  });
  vm.runInContext(source.slice(start, end), context);
  for (const action of ['menu', 'delete']) {
    for (const confirmed of [undefined, null, false, 'true', 1, {}]) {
      const result = await context.pluginAction('clipboard', action, { id: 7, confirmed });
      assert.equal(result.ok, false);
      assert.equal(result.cancelled, true);
    }
    for (const id of [undefined, null, '', 0, -1, 1.5, NaN, Infinity, 'invalid', Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await context.pluginAction('clipboard', action, { id, confirmed: true })).ok, false);
    }
    document.documentElement.dataset.weborgReadonly = 'true';
    const result = await context.pluginAction('clipboard', action, { id: 7, confirmed: true });
    assert.equal(result.ok, false);
    assert.equal(result.readonly, true);
    document.documentElement.dataset.weborgReadonly = 'false';
  }
  assert.equal(calls.length, 0);
  for (const action of ['menu', 'delete']) {
    assert.equal((await context.pluginAction('clipboard', action, { id: 7, confirmed: true })).ok, true);
  }
  assert.equal(calls.length, 2);
  for (const [command, payload] of calls) {
    assert.equal(command, 'delete_clipboard');
    assert.equal(payload.id, 7);
  }
  context.invoke = async () => { throw new Error('fixture native rejection'); };
  await assert.rejects(context.pluginAction('clipboard', 'delete', { id: 7, confirmed: true }), /fixture native rejection/);
});
