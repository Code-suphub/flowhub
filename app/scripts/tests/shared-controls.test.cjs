const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const app = path.resolve(__dirname, '../..');
// A virtual entry exercises the real shared controls without changing main,
// writing build artifacts, or depending on another agent's host bundle.
const entry = path.join(app, 'src/__shared_controls_test__.js');
let bundle;
before(async () => {
  const { build } = await import('vite');
  const result = await build({
    configFile: false, root: app, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [{
      name: 'shared-controls-test-entry',
      resolveId(id) { if (id === entry) return entry; },
      load(id) {
        if (id !== entry) return;
        return `
          import {createElement as h, useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {Select, Tooltip, Switch} from './shared/controls.tsx';
          function Harness({kind, initial, onChange, content, ...props}) {
            const [value, setValue] = useState(initial);
            const change = next => {onChange(next);setValue(next);};
            if (kind === 'select') return h(Select, {...props, value, onChange: change});
            if (kind === 'switch') return h(Switch, {...props, checked: value, onChange: change});
            return h(Tooltip, {content}, h('button', {type:'button'}, 'Tooltip trigger'));
          }
          export function mount(root, props) {
            const mounted = createRoot(root);
            mounted.render(h(Harness, props));
            return mounted;
          }
        `;
      },
    }],
    build: { write: false, minify: false, lib: { entry, name: 'SharedControlsTest', formats: ['iife'] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk').code;
});

async function wait(predicate, message = 'React state did not settle') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), message);
}
const options = [
  { value: 'disabled-first', label: 'Disabled first', disabled: true },
  { value: 'alpha', label: 'Alpha' },
  { value: 'disabled-middle', label: 'Beta unavailable', disabled: true },
  { value: 'beta', label: 'Beta' },
  { value: 'disabled-second', label: 'Disabled second', disabled: true },
  { value: 'gamma', label: 'Gamma' },
  { value: 'disabled-last', label: 'Disabled last', disabled: true },
];
async function setup(t, kind, overrides = {}) {
  const dom = new JSDOM('<button id="before">Before</button><div id="root"></div><button id="after">After</button>', {
    url: 'http://shared-controls.test/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, document = w.document, calls = [], errors = [];
  w.addEventListener('error', event => errors.push(event.error || event.message));
  w.eval(bundle);
  const root = w.SharedControlsTest.mount(document.getElementById('root'), {
    kind, label: 'Test control', initial: kind === 'switch' ? false : 'alpha',
    options, content: 'Keyboard-accessible explanation', ...overrides,
    onChange: value => calls.push(value),
  });
  let unmounted = false;
  const unmount = () => { if (!unmounted) { root.unmount(); unmounted = true; } };
  t.after(() => { unmount(); dom.window.close(); assert.deepEqual(errors, [], 'No browser runtime errors'); });
  const triggerSelector = kind === 'switch' ? '#root [role="switch"]' : '#root button';
  await wait(() => document.querySelector(triggerSelector));
  const trigger = document.querySelector(triggerSelector);
  const key = value => {
    const event = new w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
    trigger.dispatchEvent(event); return event;
  };
  const active = () => document.getElementById(trigger.getAttribute('aria-activedescendant'));
  const list = () => document.querySelector('[role="listbox"]');
  const tooltip = () => document.querySelector('[role="tooltip"]');
  return { w, document, trigger, calls, key, active, list, tooltip, unmount };
}

test('Select arrows skip disabled items, wrap, and Enter selects the active option', async t => {
  const s = await setup(t, 'select'); s.trigger.focus();
  assert.equal(s.trigger.getAttribute('role'), 'combobox');
  assert.equal(s.trigger.getAttribute('aria-label'), 'Test control');
  assert.equal(s.key('ArrowDown').defaultPrevented, true);
  await wait(() => s.active()?.textContent === 'Beta');
  assert.equal(s.document.activeElement, s.trigger, 'Keyboard focus remains on the combobox');
  assert.equal(s.trigger.getAttribute('aria-controls'), s.list().id);
  assert.equal(s.active().disabled, false);
  s.key('ArrowDown'); await wait(() => s.active()?.textContent === 'Gamma');
  s.key('ArrowDown'); await wait(() => s.active()?.textContent === 'Alpha');
  s.key('ArrowUp'); await wait(() => s.active()?.textContent === 'Gamma');
  s.key('ArrowUp'); await wait(() => s.active()?.textContent === 'Beta');
  s.key('Enter'); await wait(() => !s.list());
  assert.deepEqual(s.calls, ['beta']);
  assert.match(s.trigger.textContent, /Beta/);
  assert.equal(s.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(s.trigger.hasAttribute('aria-activedescendant'), false);
  assert.equal(s.trigger.hasAttribute('aria-controls'), false);
  assert.equal(s.document.activeElement, s.trigger);
});

test('Select Home/End skip disabled boundary options and Space commits selection', async t => {
  const s = await setup(t, 'select'); s.trigger.focus();
  s.key('End'); await wait(() => s.active()?.textContent === 'Gamma');
  s.key('Home'); await wait(() => s.active()?.textContent === 'Alpha');
  s.key('End'); await wait(() => s.active()?.textContent === 'Gamma');
  assert.equal(s.key(' ').defaultPrevented, true);
  await wait(() => !s.list()); assert.deepEqual(s.calls, ['gamma']);
});

test('Select Escape cancels navigation without changing the selected value or bubbling', async t => {
  const s = await setup(t, 'select'); s.trigger.focus();
  s.key('ArrowDown'); await wait(() => s.active()?.textContent === 'Beta');
  let escaped = 0;
  s.document.addEventListener('keydown', event => { if (event.key === 'Escape') escaped++; });
  assert.equal(s.key('Escape').defaultPrevented, true);
  await wait(() => !s.list());
  assert.equal(escaped, 0); assert.deepEqual(s.calls, []);
  assert.match(s.trigger.textContent, /Alpha/);
  assert.equal(s.document.activeElement, s.trigger);
  s.trigger.click(); await wait(() => s.list());
  assert.equal(s.active().textContent, 'Alpha', 'Reopening restores the selected option');
});

test('Select Tab remains native and leaving focus closes without selecting', async t => {
  const s = await setup(t, 'select'); s.trigger.focus();
  s.key('ArrowDown'); await wait(() => s.list());
  assert.ok([...s.list().querySelectorAll('[role="option"]')].every(option => option.tabIndex === -1));
  assert.equal(s.key('Tab').defaultPrevented, false, 'Do not trap Tab inside the popup');
  // jsdom has no browser Tab default action; explicitly perform its focus transfer.
  const after = s.document.getElementById('after'); after.focus();
  await wait(() => !s.list());
  assert.equal(s.document.activeElement, after); assert.deepEqual(s.calls, []);
  assert.equal(s.trigger.hasAttribute('aria-activedescendant'), false);
});

test('Select pointer choices reject disabled options and outside pointer dismisses', async t => {
  const s = await setup(t, 'select'); s.trigger.focus(); s.trigger.click();
  await wait(() => s.list());
  s.list().querySelector('[disabled]').click(); assert.deepEqual(s.calls, []); assert.ok(s.list());
  [...s.list().querySelectorAll('[role="option"]')].find(option => option.textContent === 'Beta').click();
  await wait(() => !s.list()); assert.deepEqual(s.calls, ['beta']);
  assert.equal(s.document.activeElement, s.trigger);
  s.trigger.click(); await wait(() => s.list());
  s.document.getElementById('after').dispatchEvent(new s.w.Event('pointerdown', { bubbles: true }));
  await wait(() => !s.list()); assert.deepEqual(s.calls, ['beta']);
});

test('Select typeahead ignores disabled matching labels', async t => {
  const s = await setup(t, 'select'); s.trigger.focus();
  s.key('b'); await wait(() => s.active()?.textContent === 'Beta');
  assert.equal(s.active().disabled, false);
  s.key('e'); await wait(() => s.active()?.textContent === 'Beta');
  s.key('Enter'); await wait(() => !s.list()); assert.deepEqual(s.calls, ['beta']);
});

test('disabled Select cannot open or change through native click/focus', async t => {
  const s = await setup(t, 'select', { disabled: true });
  const before = s.document.getElementById('before'); before.focus();
  s.trigger.focus(); s.trigger.click();
  assert.equal(s.trigger.disabled, true); assert.equal(s.document.activeElement, before);
  assert.equal(s.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(s.list(), null); assert.deepEqual(s.calls, []);
});

test('Tooltip focus exposes its description; Escape removes both popup and association', async t => {
  const s = await setup(t, 'tooltip');
  assert.equal(s.tooltip(), null); s.trigger.focus();
  await wait(() => s.tooltip());
  assert.equal(s.tooltip().textContent, 'Keyboard-accessible explanation');
  assert.equal(s.trigger.getAttribute('aria-describedby'), s.tooltip().id);
  let escaped = 0;
  s.document.addEventListener('keydown', event => { if (event.key === 'Escape') escaped++; });
  assert.equal(s.key('Escape').defaultPrevented, true);
  await wait(() => !s.tooltip());
  assert.equal(s.trigger.hasAttribute('aria-describedby'), false);
  assert.equal(s.document.activeElement, s.trigger); assert.equal(escaped, 0);
  s.document.getElementById('after').focus(); s.trigger.focus();
  await wait(() => s.tooltip());
  s.document.getElementById('after').focus(); await wait(() => !s.tooltip());
  assert.equal(s.trigger.hasAttribute('aria-describedby'), false);
});

test('Tooltip scroll, resize and unmount clear the description lifecycle', async t => {
  const s = await setup(t, 'tooltip');
  const reopen = async () => { s.document.getElementById('after').focus(); s.trigger.focus(); await wait(() => s.tooltip()); };
  await reopen(); s.w.dispatchEvent(new s.w.Event('resize')); await wait(() => !s.tooltip());
  assert.equal(s.trigger.hasAttribute('aria-describedby'), false);
  await reopen(); s.document.dispatchEvent(new s.w.Event('scroll')); await wait(() => !s.tooltip());
  assert.equal(s.trigger.hasAttribute('aria-describedby'), false);
  await reopen(); s.unmount();
  assert.equal(s.tooltip(), null); assert.equal(s.trigger.hasAttribute('aria-describedby'), false);
  s.w.dispatchEvent(new s.w.Event('resize')); s.document.dispatchEvent(new s.w.Event('scroll'));
});

test('Tooltip without content creates no empty popup or dangling description', async t => {
  const s = await setup(t, 'tooltip', { content: undefined }); s.trigger.focus();
  // Flush the focus state update before checking the absence of a popup.
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(s.tooltip(), null); assert.equal(s.trigger.hasAttribute('aria-describedby'), false);
});

test('Switch emits controlled booleans and exposes checked state and label', async t => {
  const s = await setup(t, 'switch');
  assert.equal(s.trigger.getAttribute('role'), 'switch');
  assert.equal(s.trigger.getAttribute('aria-label'), 'Test control');
  assert.equal(s.trigger.getAttribute('aria-checked'), 'false');
  s.trigger.click(); await wait(() => s.trigger.getAttribute('aria-checked') === 'true');
  s.trigger.click(); await wait(() => s.trigger.getAttribute('aria-checked') === 'false');
  assert.deepEqual(s.calls, [true, false]);
});

test('disabled Switch preserves checked state and never calls onChange', async t => {
  const s = await setup(t, 'switch', { initial: true, disabled: true });
  const before = s.document.getElementById('before'); before.focus();
  s.trigger.focus(); s.trigger.click(); s.trigger.click();
  assert.equal(s.trigger.getAttribute('aria-disabled'), 'true'); assert.equal(s.trigger.tabIndex, -1);
  assert.equal(s.trigger.getAttribute('aria-checked'), 'true'); assert.deepEqual(s.calls, []);
});
