const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./settings-harness.test.cjs');
const { CanvasSettings } = require('../../src/settings/CanvasSettings.tsx');
const toggle = label => document.querySelector(`[role=switch][aria-label="${label}"]`);
const modeEvent = (type, enabled) => window.dispatchEvent(new window.CustomEvent(type, { detail: enabled }));

test('canvas settings load legacy modes, persist lock independently and synchronize remote mode changes', async () => {
  h.environment(); const calls = []; let layout = {};
  window.__TAURI__.core.invoke = async (command, args) => {
    calls.push(args);
    if (args.action === 'setLayoutLocked') layout = { ...layout, layoutLocked: args.payload.enabled };
    if (args.action === 'setViewOnly') layout = { ...layout, viewOnly: args.payload.enabled };
    return { layout };
  };
  let view = await h.mount(CanvasSettings);
  assert.equal(toggle('锁定布局').getAttribute('aria-checked'), 'false');
  assert.equal(toggle('仅查看桌面组件').getAttribute('aria-checked'), 'false');
  await h.click(toggle('锁定布局'));
  assert.equal(toggle('锁定布局').getAttribute('aria-checked'), 'true');
  assert.ok(calls.some(call => call.action === 'setLayoutLocked' && call.payload.enabled));
  await view.unmount(); view = await h.mount(CanvasSettings);
  assert.equal(toggle('锁定布局').getAttribute('aria-checked'), 'true');
  await h.act(async () => modeEvent('flowhub:canvas-layout-locked', false));
  assert.equal(toggle('锁定布局').getAttribute('aria-checked'), 'false');
  await h.click(toggle('仅查看桌面组件'));
  assert.equal(toggle('仅查看桌面组件').getAttribute('aria-checked'), 'true');
  assert.equal(toggle('锁定布局').getAttribute('aria-checked'), 'false');
  await view.unmount();
});

test('settings retain the original mode after save errors and keep native controls disabled in browser preview', async () => {
  h.environment();
  window.__TAURI__.core.invoke = async (command, args) => {
    if (args.action === 'get') return { layout: { layoutLocked: true } };
    throw Error('disk unavailable');
  };
  let view = await h.mount(CanvasSettings);
  await h.click(toggle('锁定布局'));
  assert.equal(toggle('锁定布局').getAttribute('aria-checked'), 'true');
  assert.equal(toggle('锁定布局').hasAttribute('data-disabled'), false);
  assert.match(document.querySelector('[role=alert]').textContent, /disk unavailable/);
  await view.unmount(); h.environment({}, true); view = await h.mount(CanvasSettings);
  assert.equal(toggle('锁定布局').hasAttribute('data-disabled'), true);
  assert.equal(toggle('仅查看桌面组件').hasAttribute('data-disabled'), true);
  await view.unmount();
});

test('settings initial fetch merges independently updated modes', async () => {
  h.environment(); let resolveGet;
  window.__TAURI__.core.invoke = () => new Promise(resolve => { resolveGet = resolve; });
  const view = await h.mount(CanvasSettings);
  await h.act(async () => {
    modeEvent('flowhub:canvas-layout-locked', true);
    resolveGet({ layout: { layoutLocked: false, viewOnly: true } });
  });
  assert.equal(toggle('锁定布局').getAttribute('aria-checked'), 'true');
  assert.equal(toggle('仅查看桌面组件').getAttribute('aria-checked'), 'true');
  await view.unmount();
});

test('settings ignore a delayed acknowledgement after a newer remote mode event', async () => {
  for (const [action, event, label] of [
    ['setLayoutLocked', 'flowhub:canvas-layout-locked', '锁定布局'],
    ['setViewOnly', 'flowhub:canvas-view-only', '仅查看桌面组件'],
  ]) {
    h.environment(); let resolveMode;
    window.__TAURI__.core.invoke = async (command, args) => args.action === action ? new Promise(resolve => { resolveMode = resolve; }) : { layout: {} };
    const view = await h.mount(CanvasSettings);
    await h.click(toggle(label));
    await h.act(async () => {
      modeEvent(event, false);
      resolveMode({ layout: {} });
    });
    assert.equal(toggle(label).getAttribute('aria-checked'), 'false');
    assert.equal(toggle(label).hasAttribute('data-disabled'), false);
    await view.unmount();
  }
});
