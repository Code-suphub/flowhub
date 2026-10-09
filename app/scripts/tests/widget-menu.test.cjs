const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, ready, wait } = require('./widget-canvas-react.test.cjs');

test('layout dropdown vanishes with the native toolbar instead of remaining above desktop cards', async t => {
  const s = setup(t); await ready(s);
  const popup = () => [...s.w.document.querySelectorAll('[data-slot="select-content"]')].find(node => !node.closest('[hidden]'));
  s.w.document.getElementById('boards').click();
  await wait(() => popup());
  s.setCursor({ x: 20, y: 20, frontmost: false });
  await wait(() => s.w.document.querySelector('.canvas-toolbar').hasAttribute('inert'));
  await wait(() => !popup());
  s.setCursor({ x: 20, y: 20, frontmost: true });
  await wait(() => !s.w.document.querySelector('.canvas-toolbar').hasAttribute('inert'));
  assert.equal(popup(), undefined);
  assert.equal(s.w.document.getElementById('boards').getAttribute('aria-expanded'), 'false');
});

test('right-click on an inactive desktop card keeps its menu usable without a preceding left-click', async t => {
  const s = setup(t); await ready(s);
  const card = s.w.document.querySelector('.canvas-card');
  s.setCursor({ x: 20, y: 20, frontmost: false });
  await wait(() => s.w.document.querySelector('.canvas-toolbar').hasAttribute('inert'));
  card.dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
  await wait(() => s.button('编辑组件'));
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.ok(s.button('编辑组件'), 'background application state must not dismiss a directly opened context menu');
  s.w.dispatchEvent(new s.w.Event('blur'));
  await wait(() => !s.button('编辑组件'));
  card.dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
  await wait(() => s.button('编辑组件'));
  s.setCursor({ x: 600, y: 450, frontmost: false });
  await wait(() => !s.button('编辑组件'));
});

test('opening a context menu invalidates an earlier native cursor sample', async t => {
  let resolveCursor, first = true;
  const s = setup(t, { invoke: (command, args) => {
    if (args.action === 'cursor' && first) { first = false; return new Promise(resolve => { resolveCursor = resolve; }); }
  } });
  await ready(s); await wait(() => resolveCursor);
  s.w.document.querySelector('.canvas-card').dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
  await wait(() => s.button('编辑组件'));
  resolveCursor({ x: -1, y: -1, frontmost: false });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(s.button('编辑组件'), 'a cursor request started before the right-click must not close its menu');
});

test('native cursor dismisses React menus across iframe boundaries without DOM leave events', async t => {
  const s = setup(t); await ready(s);
  const card = s.w.document.querySelector('.canvas-card');
  for (let index = 0; index < 3; index++) {
    s.setCursor({ x: 20, y: 20 });
    card.dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    await wait(() => s.w.document.querySelector('[role=menu]'));
    s.setCursor({ x: 600, y: 450 });
    await wait(() => !s.w.document.querySelector('[role=menu]'));
  }
});

test('returning to a card cancels menu dismissal and replacement menus ignore stale leave timers', async t => {
  const s = setup(t); await ready(s);
  const card = s.w.document.querySelector('.canvas-card');
  const open = () => card.dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
  open(); await wait(() => s.w.document.querySelector('[role=menu]'));
  s.pointer(card, 'pointermove', 600, 450); s.pointer(card, 'pointermove', 20, 20);
  await new Promise(resolve => setTimeout(resolve, 220)); assert.ok(s.w.document.querySelector('[role=menu]'));
  s.pointer(card, 'pointermove', 600, 450); open();
  await new Promise(resolve => setTimeout(resolve, 220)); assert.ok(s.w.document.querySelector('[role=menu]'));
  s.w.dispatchEvent(new s.w.Event('blur')); await wait(() => !s.w.document.querySelector('[role=menu]'));
});

test('toolbar follows native cursor exit and re-entry; iframe pointerleave alone never hides it', async t => {
  const s = setup(t); await ready(s);
  const toolbar = s.w.document.querySelector('.canvas-toolbar');
  s.w.document.documentElement.dispatchEvent(new s.w.Event('pointerleave'));
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(toolbar.hasAttribute('inert'), false);
  for (let index = 0; index < 3; index++) {
    s.setCursor({ x: -1, y: 20 }); await wait(() => toolbar.hasAttribute('inert')); assert.ok(toolbar.classList.contains('surface-inactive'));
    s.setCursor({ x: 20, y: 20 }); await wait(() => !toolbar.hasAttribute('inert')); assert.equal(toolbar.classList.contains('surface-inactive'), false);
  }
  s.setCursor({ x: 20, y: 20, frontmost: false }); await wait(() => toolbar.hasAttribute('inert'));
});
