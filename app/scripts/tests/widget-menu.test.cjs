const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, ready, wait } = require('./widget-canvas-react.test.cjs');

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
