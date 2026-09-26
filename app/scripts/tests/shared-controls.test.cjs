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
          import {Button} from './shared/ui.tsx';
          function Harness({kind, initial, onChange, content, ...props}) {
            const [value, setValue] = useState(initial);
            const change = next => {onChange(next);setValue(next);};
            if (kind === 'button') return h(Button, {className: props.className, disabled: props.disabled, type: props.type, variant: props.variant, onClick: () => onChange('clicked')}, 'Action');
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

test('Button preserves native click and disabled behavior with shadcn variants', async t => {
  const normal = await setup(t, 'button', { className: 'tool-action' });
  assert.equal(normal.trigger.type, 'button');
  assert.ok(normal.trigger.classList.contains('fh-button'));
  assert.ok(normal.trigger.classList.contains('tool-action'));
  assert.ok(normal.trigger.classList.contains('border-border'));
  normal.trigger.click();
  assert.deepEqual(normal.calls, ['clicked']);

  const primary = await setup(t, 'button', { className: 'primary', type: 'submit' });
  assert.equal(primary.trigger.type, 'submit');
  assert.ok(primary.trigger.classList.contains('bg-primary'));
  assert.equal(primary.trigger.classList.contains('primary'), false);

  const danger = await setup(t, 'button', { className: 'danger', disabled: true });
  assert.ok(danger.trigger.classList.contains('text-destructive'));
  assert.equal(danger.trigger.disabled, true);
  danger.trigger.click();
  assert.deepEqual(danger.calls, []);
});

test('Select renders its controlled value, label, options and disabled items', async t => {
  const s = await setup(t, 'select');
  assert.equal(s.trigger.getAttribute('role'), 'combobox');
  assert.equal(s.trigger.getAttribute('aria-label'), 'Test control');
  assert.match(s.trigger.textContent, /Alpha/);
  s.trigger.click(); await wait(() => s.trigger.getAttribute('aria-expanded') === 'true');
  assert.equal(s.list().getAttribute('role'), 'listbox');
  assert.equal(s.list().querySelectorAll('[role="option"]').length, options.length);
  assert.equal(s.list().querySelector('[aria-selected="true"]').textContent, 'Alpha');
  assert.equal(s.list().querySelector('[data-disabled]').getAttribute('aria-disabled'), 'true');
});

test('Select ignores disabled items and commits an enabled pointer choice', async t => {
  const s = await setup(t, 'select');
  s.trigger.click(); await wait(() => s.trigger.getAttribute('aria-expanded') === 'true');
  s.list().querySelector('[data-disabled]').click();
  assert.deepEqual(s.calls, []);
  const beta = [...s.list().querySelectorAll('[role="option"]')].find(option => option.textContent === 'Beta');
  beta.dispatchEvent(new s.w.Event('pointerdown', { bubbles: true })); beta.click();
  await wait(() => s.calls.length === 1);
  assert.deepEqual(s.calls, ['beta']);
  await wait(() => s.trigger.getAttribute('aria-expanded') === 'false');
  assert.match(s.trigger.textContent, /Beta/);
});

test('Select Escape cancels without changing the controlled value', async t => {
  const s = await setup(t, 'select');
  s.trigger.click(); await wait(() => s.trigger.getAttribute('aria-expanded') === 'true');
  s.key('Escape'); await wait(() => s.trigger.getAttribute('aria-expanded') === 'false');
  assert.deepEqual(s.calls, []);
  assert.match(s.trigger.textContent, /Alpha/);
});

test('disabled Select does not open or change', async t => {
  const s = await setup(t, 'select', { disabled: true });
  assert.equal(s.trigger.disabled, true);
  s.trigger.click();
  assert.equal(s.trigger.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(s.calls, []);
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

test('Tooltip remains described across viewport changes and cleans up on unmount', async t => {
  const s = await setup(t, 'tooltip');
  s.trigger.focus(); await wait(() => s.tooltip());
  s.w.dispatchEvent(new s.w.Event('resize'));
  s.document.dispatchEvent(new s.w.Event('scroll'));
  assert.equal(s.trigger.getAttribute('aria-describedby'), s.tooltip().id);
  s.unmount();
  assert.equal(s.tooltip(), null);
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
