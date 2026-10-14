const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const app = path.resolve(__dirname, '../..');
let bundle;
before(async () => {
  const { build } = await import('vite');
  const result = await build({ configFile: false, root: app, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('production') }, build: { write: false, minify: false, lib: { entry: path.join(app, 'src/canvas/index.tsx'), name: 'CanvasTest', formats: ['iife'] } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk').code;
});
const wait = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.ok(predicate(), 'React state did not settle'); };
const source = { id: 'test', title: '测试插件', snapshot: { count: 1 }, widget: { card: 'card.html', editor: 'editor.html', interactive: true, minWidth: 330, minHeight: 290 } };
const card = { id: 'one', plugin: 'test', title: '卡片', config: { filter: 'first' }, size: 'medium', width: 384, height: 360, x: 0, y: 0 };
const layout = () => ({ active: 'default', pinned: false, boards: [{ id: 'default', title: '默认布局', cards: [{ ...card }] }] });
function setup(t, options = {}) {
  const dom = new JSDOM('<div id="canvas-root"></div>', { url: 'http://localhost/plugin-canvas.html' + (options.preview ? '?preview=' + encodeURIComponent(typeof options.preview === 'string' ? options.preview : 'http://localhost/demo/') : ''), runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [], intervals = [], errors = [], responses = [];
  w.structuredClone = structuredClone;
  w.addEventListener('error', event => errors.push(event.error));
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.HTMLElement.prototype.setPointerCapture = function (id) { this.capture = id; };
  w.HTMLElement.prototype.hasPointerCapture = function (id) { return this.capture === id; };
  w.HTMLElement.prototype.releasePointerCapture = function () { this.capture = undefined; };
  const originalRect = w.HTMLElement.prototype.getBoundingClientRect;
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.dataset.id || this.classList.contains('canvas-menu')) { const left = parseInt(this.style.left) || 0, top = parseInt(this.style.top) || 0, width = parseInt(this.style.width) || 168, height = parseInt(this.style.height) || 130; return { left, top, width, height, right: left + width, bottom: top + height }; }
    return originalRect.call(this);
  };
  w.setInterval = (callback, ms) => { intervals.push({ callback, ms }); return intervals.length; };
  w.clearInterval = () => {};
  let cursor = { x: 20, y: 20, frontmost: true }, data = { layout: options.layout || layout(), sources: [structuredClone(source)] };
  if (!options.preview) w.__TAURI__ = { core: { invoke: async (command, args) => {
    calls.push({ command, ...structuredClone(args) });
    if (options.invoke) { const override = options.invoke(command, args); if (override !== undefined) return override; }
    if (args.action === 'cursor') return cursor;
    if (args.action === 'get') return structuredClone(data);
    return null;
  } } };
  else { w.fetch = options.fetch || (async () => ({ ok: true, json: async () => structuredClone(source) })); w.localStorage.setItem('flowhub-canvas-preview', JSON.stringify(data.layout)); }
  w.eval(fs.readFileSync(path.join(app, 'ui/plugin/widget-layout.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(app, 'ui/plugin/widget-frame.js'), 'utf8'));
  w.eval(bundle); const root = w.CanvasTest.mountCanvas(w.document.getElementById('canvas-root'));
  const button = label => [...w.document.querySelectorAll('button')].find(node => node.textContent === label);
  const message = (frame, body, overrides = {}) => w.dispatchEvent(new w.MessageEvent('message', { source: frame.contentWindow, data: { ...body, token: new URLSearchParams(new URL(frame.src).hash.slice(1)).get('flowhubWidgetToken') }, ...overrides }));
  const frameMessages = frame => { frame.contentWindow.postMessage = message => responses.push({ frame, ...message }); };
  const pointer = (node, type, x, y) => node.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
  const input = (node, value) => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const submit = id => w.document.getElementById(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  t.after(() => { root.unmount(); dom.window.close(); assert.deepEqual(errors, []); });
  return { w, root, calls, intervals, responses, button, message, frameMessages, pointer, input, submit, setCursor: value => { cursor = value; }, data };
}
const ready = s => wait(() => s.w.document.querySelector('.widget-content')?.src.includes('flowhubWidgetToken') && !s.w.document.getElementById('add').disabled);
async function edit(s) { const node = s.w.document.querySelector('.canvas-card'); node.dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })); await wait(() => s.button('编辑组件')); s.button('编辑组件').click(); await wait(() => s.w.document.querySelector('#widgetEditor')?.src.includes('flowhubWidgetToken')); return s.w.document.querySelector('#widgetEditor'); }
async function more(s) { s.w.document.getElementById('canvasMore').click(); await wait(() => s.w.document.getElementById('newBoard')); }

if (require.main === module) {
test('React owns the entry and retains the original isolated bridge, with no legacy renderer', () => {
  const html = fs.readFileSync(path.join(app, 'ui/plugin-canvas.html'), 'utf8');
  assert.match(html, /id="canvas-root"/); assert.match(html, /plugin\/widget-frame.js/); assert.match(html, /react\/host.js/);
  assert.doesNotMatch(html, /plugin\/plugin-canvas\.(js|css)/);
  assert.equal(fs.existsSync(path.join(app, 'ui/plugin/plugin-canvas.js')), false);
});

test('empty canvas explains how to add a component and opens the editor', async t => {
  const emptyLayout = layout(); emptyLayout.boards[0].cards = [];
  const s = setup(t, { layout: emptyLayout });
  await wait(() => s.button('添加第一个组件') && !s.w.document.getElementById('add').disabled);
  assert.equal(s.w.document.getElementById('add').textContent, '添加');
  assert.ok(s.w.document.querySelector('.canvas-blank[data-slot="empty"]'));
  assert.equal(s.w.document.querySelector('.canvas-blank [data-slot="empty-title"]').textContent, '还没有组件');
  assert.match(s.w.document.querySelector('.canvas-blank').textContent, /从已安装的插件中添加组件/);
  s.button('添加第一个组件').click();
  await wait(() => s.w.document.getElementById('widgetForm'));
  assert.ok(s.w.document.querySelector('.fh-dialog.canvas-editor-dialog'));
  const css = fs.readFileSync(path.join(app, 'src/canvas/canvas.css'), 'utf8');
  assert.match(css, /\.fh-dialog\.canvas-editor-dialog\s*\{[^}]*height:\s*min\(/);
  assert.match(css, /\.canvas-editor-dialog #widgetForm\s*\{[^}]*overflow-y:\s*auto/);
});

test('layout dropdown stays outside the isolated widget iframe layer', async t => {
  const s = setup(t); await ready(s);
  s.w.document.getElementById('boards').click();
  await wait(() => s.w.document.querySelector('[data-slot="select-content"]'));
  const popup = s.w.document.querySelector('[data-slot="select-content"]');
  assert.ok(popup.classList.contains('canvas-board-select-popup'));
  assert.equal(s.w.document.getElementById('canvas').contains(popup), false);
  assert.ok(popup.closest('.z-50'));
  const css = fs.readFileSync(path.join(app, 'src/canvas/canvas.css'), 'utf8');
  assert.match(css, /\.fh-canvas-app #canvas\s*\{[^}]*z-index:\s*0;[^}]*isolation:\s*isolate/);
  assert.match(css, /\.canvas-toolbar\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1/);
});

test('icon-only drag and widget settings in More remain accessible in interactive mode', async t => {
  const s = setup(t); await ready(s);
  const drag = s.w.document.getElementById('dragSurface');
  assert.equal(drag.textContent.trim(), '');
  assert.equal(drag.getAttribute('aria-label'), '拖动桌面组件区域');
  assert.equal(drag.hasAttribute('title'), false);
  assert.equal(s.w.document.querySelector('[aria-label="画布操作说明"]'), null);
  assert.equal(s.w.document.querySelector('[aria-label="仅查看桌面组件"]').parentElement.hasAttribute('title'), false);
  assert.equal(s.w.document.getElementById('canvasSettings'), null);
  await more(s);
  s.w.document.getElementById('canvasSettings').click();
  await wait(() => s.calls.some(call => call.action === 'settings'));
  s.w.document.querySelector('.canvas-card').dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  await wait(() => s.button('桌面组件设置'));
  s.button('桌面组件设置').click();
  await wait(() => s.calls.filter(call => call.action === 'settings').length === 2);
});

test('toolbar view-only switch persists immediately, locks the canvas, and settings can unlock it', async t => {
  const s = setup(t); await ready(s);
  const toggle = s.w.document.querySelector('[role=switch][aria-label="仅查看桌面组件"]');
  assert.ok(toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  toggle.click();
  await wait(() => s.calls.some(call => call.action === 'setViewOnly'));
  assert.deepEqual(s.calls.find(call => call.action === 'setViewOnly').payload, { enabled: true });
  await wait(() => s.w.document.querySelector('.fh-canvas-app').dataset.viewOnly === 'true');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(s.w.document.querySelector('.canvas-toolbar').hasAttribute('inert'), true);
  s.w.dispatchEvent(new s.w.CustomEvent('flowhub:canvas-view-only', { detail: false }));
  await wait(() => s.w.document.querySelector('.fh-canvas-app').dataset.viewOnly === 'false');
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
});

test('More keyboard navigation skips disabled actions, restores focus and stays separate from card menus', async t => {
  const s = setup(t); await ready(s);
  const trigger = s.w.document.getElementById('canvasMore');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(s.w.document.getElementById('newBoard'), null);
  trigger.focus();
  trigger.dispatchEvent(new s.w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }));
  await wait(() => s.w.document.activeElement === s.button('新建布局'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(s.w.document.getElementById('canvasMenu').getAttribute('aria-label'), '布局与桌面组件操作');
  assert.equal(s.w.document.getElementById('removeBoard').disabled, true);
  s.button('新建布局').dispatchEvent(new s.w.KeyboardEvent('keydown', { bubbles: true, key: 'End' }));
  assert.equal(s.w.document.activeElement, s.button('桌面组件设置'));
  s.button('桌面组件设置').dispatchEvent(new s.w.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }));
  assert.equal(s.w.document.activeElement, s.button('重命名布局'));
  s.button('重命名布局').dispatchEvent(new s.w.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
  await wait(() => !s.w.document.getElementById('canvasMenu'));
  assert.equal(s.w.document.activeElement, trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await more(s);
  s.w.document.querySelector('.canvas-card').dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
  await wait(() => s.button('编辑组件'));
  assert.equal(s.w.document.getElementById('newBoard'), null);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('More closes on trigger toggle, outside input, iframe focus, layout switch and native exit', async t => {
  const s = setup(t); await ready(s);
  const trigger = s.w.document.getElementById('canvasMore');
  await more(s); s.pointer(trigger, 'pointerdown', 20, 20); trigger.click();
  await wait(() => !s.w.document.getElementById('canvasMenu'));
  await more(s); s.pointer(s.w.document.getElementById('canvas'), 'pointerdown', 500, 400);
  await wait(() => !s.w.document.getElementById('canvasMenu'));
  await more(s); s.w.document.querySelector('iframe').focus();
  await wait(() => !s.w.document.getElementById('canvasMenu'));
  await more(s); s.w.document.getElementById('boards').click();
  await wait(() => s.w.document.querySelector('[role=option]'));
  s.w.document.querySelector('[role=option]').click();
  await wait(() => !s.w.document.getElementById('canvasMenu'));
  await more(s); s.setCursor({ x: -1, y: -1 });
  await wait(() => !s.w.document.getElementById('canvasMenu'));
});

test('More anchors within a narrow resized window and dialogs restore the persistent trigger', async t => {
  const s = setup(t); await ready(s);
  const trigger = s.w.document.getElementById('canvasMore');
  trigger.getBoundingClientRect = () => ({ left: 290, top: 180, bottom: 210 });
  Object.defineProperty(s.w, 'innerWidth', { configurable: true, value: 320 });
  Object.defineProperty(s.w, 'innerHeight', { configurable: true, value: 240 });
  await more(s);
  const popup = s.w.document.getElementById('canvasMenu');
  assert.equal(popup.style.left, '144px'); assert.equal(popup.style.top, '102px');
  assert.equal(s.w.document.getElementById('canvas').contains(popup), false);
  Object.defineProperty(s.w, 'innerWidth', { configurable: true, value: 280 });
  s.w.dispatchEvent(new s.w.Event('resize')); assert.equal(popup.style.left, '104px');
  s.button('重命名布局').click();
  await wait(() => s.w.document.getElementById('boardName'));
  assert.equal(s.w.document.getElementById('canvasMenu'), null);
  s.button('取消').click();
  await wait(() => !s.w.document.getElementById('boardName') && s.w.document.activeElement === trigger);
});

test('More preserves layout limits and preview native settings restrictions', async t => {
  const full = layout();
  full.boards.push(...Array.from({ length: 11 }, (_, i) => ({ id: `board-${i}`, title: `布局 ${i}`, cards: [] })));
  const s = setup(t, { layout: full, preview: true }); await ready(s); await more(s);
  assert.equal(s.w.document.getElementById('newBoard').disabled, true);
  assert.equal(s.w.document.getElementById('removeBoard').disabled, false);
  assert.equal(s.w.document.getElementById('canvasSettings').disabled, true);
});

test('failed toolbar lock leaves the canvas interactive and reports the error', async t => {
  const s = setup(t, { invoke: (command, args) => args.action === 'setViewOnly' ? Promise.reject(Error('disk unavailable')) : undefined });
  await ready(s);
  s.w.document.querySelector('[role=switch][aria-label="仅查看桌面组件"]').click();
  await wait(() => s.w.document.getElementById('notice').textContent.includes('disk unavailable'));
  assert.equal(s.w.document.querySelector('.fh-canvas-app').dataset.viewOnly, 'false');
});

test('view-only locks dragging and left clicks, while right-click can exit without allowing edits', async t => {
  const locked = { ...layout(), viewOnly: true };
  const s = setup(t, { layout: locked }); await ready(s);
  const node = s.w.document.querySelector('.canvas-card');
  const frame = node.querySelector('iframe');
  assert.equal(s.w.document.querySelector('.fh-canvas-app').dataset.viewOnly, 'true');
  assert.equal(s.w.document.querySelector('.canvas-toolbar').hasAttribute('inert'), true);
  const css = fs.readFileSync(path.join(app, 'src/canvas/canvas.css'), 'utf8');
  assert.match(css, /\[data-view-only="true"\] \.canvas-toolbar\s*\{[^}]*display:\s*none/);
  assert.match(css, /\[data-view-only="true"\] \.canvas-card \.widget-content\s*\{[^}]*pointer-events:\s*none/);
  assert.equal(node.tabIndex, 0);
  assert.equal(frame.tabIndex, -1);
  s.pointer(node.querySelector('.widget-hit'), 'pointerdown', 10, 10);
  s.pointer(node, 'pointermove', 200, 100);
  s.pointer(node, 'pointerup', 200, 100);
  node.click();
  node.dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  assert.equal(node.style.left, '0px');
  assert.equal(s.calls.some(call => call.action === 'detail' || call.action === 'save'), false);
  await wait(() => s.button('退出仅查看状态'));
  assert.equal(s.button('编辑组件').disabled, true);
  assert.equal(s.button('移除组件').disabled, true);
  s.button('编辑组件').click(); s.button('移除组件').click();
  assert.equal(s.w.document.getElementById('widgetForm'), null);
  assert.ok(s.w.document.querySelector('.canvas-card'));
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(s.w.document.querySelector('.fh-canvas-app').dataset.viewOnly, 'true');
  s.button('退出仅查看状态').click();
  await wait(() => s.calls.some(call => call.action === 'setViewOnly' && call.payload.enabled === false));
  await wait(() => s.w.document.querySelector('.fh-canvas-app').dataset.viewOnly === 'false');
  assert.equal(node.tabIndex, 0);
  assert.equal(frame.tabIndex, 0);
  node.click();
  await wait(() => s.calls.some(call => call.action === 'detail'));
});

test('view-only keyboard menus skip disabled edits and allow explicit detail navigation', async t => {
  const s = setup(t, { layout: { ...layout(), viewOnly: true } }); await ready(s);
  const node = s.w.document.querySelector('.canvas-card');
  node.dispatchEvent(new s.w.KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
  await wait(() => s.button('退出仅查看状态'));
  s.button('打开详情').dispatchEvent(new s.w.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
  assert.equal(s.w.document.activeElement, s.button('桌面组件设置'));
  s.button('打开详情').click(); await wait(() => s.calls.some(call => call.action === 'detail'));
  assert.equal(s.w.document.querySelector('.fh-canvas-app').dataset.viewOnly, 'true');
});

test('an empty view-only board also exposes exit, and failed exit preserves the lock', async t => {
  const empty = { ...layout(), viewOnly: true }; empty.boards[0].cards = [];
  const s = setup(t, { layout: empty, invoke: (command, args) => args.action === 'setViewOnly' ? Promise.reject(Error('disk unavailable')) : undefined });
  await wait(() => s.w.document.getElementById('add') && !s.w.document.getElementById('add').disabled);
  s.w.document.getElementById('canvas').dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
  await wait(() => s.button('退出仅查看状态'));
  s.button('退出仅查看状态').click();
  await wait(() => s.w.document.getElementById('notice').textContent.includes('disk unavailable'));
  assert.equal(s.w.document.querySelector('.fh-canvas-app').dataset.viewOnly, 'true');
});

test('pin, board create/rename/switch/delete and native drag/close persist correctly', async t => {
  const s = setup(t); await ready(s);
  s.w.document.querySelector('[role=switch]').click(); await wait(() => s.calls.some(call => call.action === 'save' && call.payload.pinned));
  s.w.document.getElementById('dragSurface').dispatchEvent(new s.w.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  s.w.document.getElementById('closeSurface').click();
  assert.ok(s.calls.some(call => call.action === 'drag')); assert.ok(s.calls.some(call => call.action === 'close'));
  await more(s); s.button('新建布局').click(); await wait(() => s.w.document.getElementById('boardName'));
  s.input(s.w.document.getElementById('boardName'), '工作'); s.submit('nameForm');
  await wait(() => s.calls.filter(call => call.action === 'save').at(-1)?.payload.boards.length === 2);
  await more(s); s.button('重命名布局').click(); await wait(() => s.w.document.getElementById('boardName'));
  s.input(s.w.document.getElementById('boardName'), '新工作'); s.submit('nameForm');
  await wait(() => s.calls.filter(call => call.action === 'save').at(-1)?.payload.boards.some(board => board.title === '新工作'));
  s.w.document.getElementById('boards').click(); await wait(() => s.w.document.querySelector('[role=option]'));
  [...s.w.document.querySelectorAll('[role=option]')].find(node => node.textContent === '默认布局').click(); await ready(s);
  await more(s); s.w.document.getElementById('removeBoard').click(); await wait(() => s.w.document.getElementById('confirmDelete'));
  s.w.document.getElementById('confirmDelete').click(); await wait(() => s.calls.filter(call => call.action === 'save').at(-1)?.payload.boards.length === 1);
  assert.equal(s.calls.filter(call => call.action === 'save').at(-1).payload.boards[0].title, '新工作');
});

test('snapshots refresh in place and stale refreshes preserve newly saved geometry', async t => {
  let resolveGet, defer = false;
  const s = setup(t, { invoke: (command, args) => args.action === 'get' && defer ? new Promise(resolve => { resolveGet = resolve; }) : undefined }); await ready(s);
  const frame = s.w.document.querySelector('.widget-content'); s.frameMessages(frame);
  s.data.sources[0].snapshot.count = 2;
  s.intervals.find(timer => timer.ms === 15000).callback(); await wait(() => s.responses.some(message => message.context?.snapshot.count === 2));
  assert.equal(s.w.document.querySelector('.widget-content'), frame);
  defer = true; s.intervals[0].callback(); await wait(() => resolveGet);
  s.w.document.querySelector('[data-resize]').dispatchEvent(new s.w.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
  await wait(() => s.calls.some(call => call.action === 'save'));
  resolveGet(structuredClone(s.data)); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(s.w.document.querySelector('.canvas-card').style.width, '394px'); assert.equal(s.w.document.querySelector('.widget-content'), frame);
});

test('desktop snapshots keep refreshing while hidden and refresh on return', async t => {
  const s = setup(t); await ready(s);
  const frame = s.w.document.querySelector('.widget-content'); s.frameMessages(frame);
  let hidden = true;
  Object.defineProperty(s.w.document, 'hidden', { configurable: true, get: () => hidden });
  s.data.sources[0].snapshot.count = 2;
  s.intervals.find(timer => timer.ms === 15000).callback();
  await wait(() => s.responses.some(message => message.context?.snapshot.count === 2));
  hidden = false;
  s.data.sources[0].snapshot.count = 3;
  s.w.document.dispatchEvent(new s.w.Event('visibilitychange'));
  await wait(() => s.responses.some(message => message.context?.snapshot.count === 3));
  assert.equal(s.w.document.querySelector('.widget-content'), frame);
});

test('pointer drag, cancellation, resize minimum and keyboard resize keep frames mounted', async t => {
  const s = setup(t); await ready(s); const node = s.w.document.querySelector('.canvas-card'), frame = node.querySelector('iframe'), hit = node.querySelector('.widget-hit');
  s.pointer(hit, 'pointerdown', 10, 10); s.pointer(node, 'pointermove', 210, 120); assert.equal(node.style.left, '200px');
  s.pointer(node, 'pointercancel', 210, 120); assert.equal(node.style.left, '0px'); assert.equal(s.calls.filter(call => call.action === 'save').length, 0);
  s.pointer(hit, 'pointerdown', 10, 10); s.pointer(node, 'pointermove', 410, 310); s.pointer(node, 'pointerup', 410, 310);
  await wait(() => s.calls.some(call => call.action === 'save'));
  const resize = node.querySelector('[data-resize]'); s.pointer(resize, 'pointerdown', 380, 350); s.pointer(node, 'pointermove', -100, -100); s.pointer(node, 'pointerup', -100, -100);
  await wait(() => node.style.width === '330px'); assert.equal(node.style.height, '290px');
  resize.dispatchEvent(new s.w.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })); await wait(() => node.style.width === '340px');
  assert.equal(node.querySelector('iframe'), frame);
});

test('editor waits for authenticated readiness and save; double submits and foreign replies are ignored', async t => {
  const s = setup(t); await ready(s); const frame = await edit(s); s.frameMessages(frame);
  const submit = () => s.w.document.querySelector('button[form="widgetForm"]');
  assert.equal(submit().form, s.w.document.getElementById('widgetForm'));
  assert.equal(s.w.document.getElementById('widgetForm').contains(submit()), false);
  s.message(frame, { type: 'flowhub:widget-size', height: 398 });
  assert.equal(frame.style.height, '398px');
  assert.equal(s.w.document.querySelectorAll('#widgetForm [data-slot="field"]').length, 2);
  assert.equal(s.w.document.getElementById('cardTitle').labels[0].textContent, '卡片名称');
  assert.equal(submit().disabled, true);
  s.message(frame, { type: 'flowhub:widget-ready' }, { source: s.w });
  s.message(frame, { type: 'flowhub:widget-ready', token: 'wrong' }, { data: { type: 'flowhub:widget-ready', token: 'wrong' } });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(submit().disabled, true);
  s.message(frame, { type: 'flowhub:widget-ready' }); await wait(() => !submit().disabled);
  s.submit('widgetForm'); s.submit('widgetForm'); await wait(() => s.responses.some(message => message.type === 'flowhub:widget-save'));
  const saves = s.responses.filter(message => message.type === 'flowhub:widget-save'); assert.equal(saves.length, 1);
  s.message(frame, { type: 'flowhub:widget-config', id: saves[0].id, config: { filter: 'bad' } }, { source: s.w });
  assert.equal(s.calls.filter(call => call.action === 'save').length, 0);
  s.message(frame, { type: 'flowhub:widget-config', id: saves[0].id, config: { filter: 'saved' } });
  await wait(() => !s.w.document.querySelector('[role="dialog"]'));
  await wait(() => s.calls.some(call => call.action === 'save'));
  assert.equal(s.calls.find(call => call.action === 'save').payload.boards[0].cards[0].config.filter, 'saved');
});

test('editor plugin title does not activate the select, while the trigger keeps its accessible name and keyboard behavior', async t => {
  const s = setup(t); await ready(s); await edit(s);
  const title = s.w.document.getElementById('sourceLabel');
  const trigger = s.w.document.getElementById('source');
  assert.equal(trigger.getAttribute('aria-labelledby'), title.id);
  title.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  trigger.click();
  await wait(() => s.w.document.querySelector('.canvas-editor-select-popup'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  trigger.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await wait(() => trigger.getAttribute('aria-expanded') === 'false');
});

test('native pointer exit disposes a pending editor and ignores late save replies', async t => {
  const s = setup(t); await ready(s); const frame = await edit(s); s.frameMessages(frame);
  s.message(frame, { type: 'flowhub:widget-ready' }); await wait(() => !s.w.document.querySelector('button[form="widgetForm"]').disabled);
  s.submit('widgetForm'); await wait(() => s.responses.some(message => message.type === 'flowhub:widget-save'));
  const save = s.responses.find(message => message.type === 'flowhub:widget-save');
  s.setCursor({ x: -20, y: -20 }); await wait(() => !s.w.document.querySelector('[role="dialog"]'));
  s.message(frame, { type: 'flowhub:widget-config', id: save.id, config: { late: true } });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(s.calls.filter(call => call.action === 'save').length, 0);
});

test('native hover closes pointer menus, re-entry shows toolbar, keyboard menu remains usable', async t => {
  const s = setup(t); await ready(s); const node = s.w.document.querySelector('.canvas-card');
  node.dispatchEvent(new s.w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })); await wait(() => s.button('编辑组件'));
  s.setCursor({ x: 600, y: 450 }); await wait(() => !s.button('编辑组件'));
  s.setCursor({ x: -1, y: -1 }); await wait(() => s.w.document.querySelector('.surface-inactive'));
  s.setCursor({ x: 20, y: 20 }); await wait(() => !s.w.document.querySelector('.surface-inactive'));
  node.dispatchEvent(new s.w.KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true })); await wait(() => s.button('编辑组件'));
  s.setCursor({ x: 600, y: 450 }); await new Promise(resolve => setTimeout(resolve, 400)); assert.ok(s.button('编辑组件'));
  s.button('打开详情').dispatchEvent(new s.w.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' })); assert.equal(s.w.document.activeElement, s.button('编辑组件'));
  s.button('移除组件').click(); await wait(() => !s.w.document.querySelector('.canvas-card'));
});

test('preview only writes its browser layout and denies plugin RPC despite authenticated messages', async t => {
  const s = setup(t, { preview: true }); await ready(s); const frame = s.w.document.querySelector('.widget-content'); s.frameMessages(frame);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  s.message(frame, { type: 'flowhub:widget-rpc', id: 'rpc', params: { action: 'write' } });
  await wait(() => s.responses.some(message => message.id === 'rpc'));
  assert.match(s.responses.find(message => message.id === 'rpc').error, /不支持插件调用/);
  s.w.document.querySelector('[role=switch]').click(); await wait(() => JSON.parse(s.w.localStorage.getItem('flowhub-canvas-preview')).pinned);
  assert.equal(s.calls.length, 0); assert.match(s.w.document.body.textContent, /浏览器预览/);
  assert.equal(s.w.document.getElementById('closeSurface').disabled, true);
});

test('invalid preview addresses offer a return route without fetching or overwriting saved layout', async t => {
  for (const address of ['插件预览地址', 'javascript:alert(1)', 'file:///tmp/demo']) {
    await t.test(address, async t => {
      let fetched = false;
      const s = setup(t, { preview: address, fetch: async () => { fetched = true; throw Error('must not fetch'); } });
      await wait(() => s.w.document.getElementById('notice')?.textContent.includes('预览地址无效'));
      const stored = s.w.localStorage.getItem('flowhub-canvas-preview');
      assert.equal(fetched, false);
      assert.equal(s.w.document.getElementById('add').disabled, true);
      assert.equal(s.w.document.getElementById('canvasMore').disabled, true);
      assert.equal(s.w.document.querySelector('.canvas-preview-return').getAttribute('href'), 'plugin-canvas.html');
      assert.doesNotMatch(s.w.document.body.textContent, /TypeError|Invalid base URL/);
      s.intervals[0].callback();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(s.w.localStorage.getItem('flowhub-canvas-preview'), stored);
    });
  }
});

test('preview directories without a trailing slash load the manifest and report unavailable services clearly', async t => {
  let requested;
  const s = setup(t, { preview: 'https://localhost/demo', fetch: async url => { requested = String(url); throw TypeError('Failed to fetch'); } });
  await wait(() => s.w.document.getElementById('notice')?.textContent.includes('预览服务已启动'));
  assert.equal(requested, 'https://localhost/demo/widget-preview.json');
  assert.ok(s.w.document.querySelector('.canvas-preview-return'));
  assert.equal(s.w.document.getElementById('add').disabled, true);
  assert.doesNotMatch(s.w.document.body.textContent, /TypeError|Failed to fetch/);
});

test('preview retry normalizes query and hash, clears the return link and loads the saved layout', async t => {
  const requests = []; let available = false;
  const s = setup(t, { preview: 'http://localhost/demo?x=1#section', fetch: async url => {
    requests.push(String(url));
    if (!available) throw TypeError('Failed to fetch');
    return { ok: true, json: async () => structuredClone(source) };
  } });
  await wait(() => s.w.document.querySelector('.canvas-preview-return'));
  const stored = s.w.localStorage.getItem('flowhub-canvas-preview');
  assert.equal(s.w.document.getElementById('add').disabled, true);
  available = true; s.intervals[0].callback(); await ready(s);
  assert.deepEqual(requests, ['http://localhost/demo/widget-preview.json', 'http://localhost/demo/widget-preview.json']);
  assert.equal(s.w.document.querySelector('.canvas-preview-return'), null);
  assert.equal(s.w.document.getElementById('notice').textContent, '浏览器预览 · 只读模拟数据');
  assert.ok(s.w.document.querySelector('[data-id="one"]'));
  assert.equal(new URL(s.w.document.querySelector('.widget-content').src).pathname, '/demo/card.html');
  assert.equal(s.w.localStorage.getItem('flowhub-canvas-preview'), stored);
  assert.equal(s.calls.length, 0);
});

test('save queue serializes immutable snapshots and recovers after a failure', async t => {
  let rejectFirst, count = 0;
  const s = setup(t, { invoke: (command, args) => { if (args.action === 'save' && ++count === 1) return new Promise((resolve, reject) => { rejectFirst = reject; }); } });
  await ready(s); s.w.document.querySelector('[role=switch]').click(); await wait(() => rejectFirst);
  s.w.document.querySelector('[role=switch]').click(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(count, 1);
  rejectFirst(Error('disk unavailable')); await wait(() => count === 2);
  const saves = s.calls.filter(call => call.action === 'save'); assert.equal(saves[0].payload.pinned, true); assert.equal(saves[1].payload.pinned, false);
});
test('first-load failure retries the actual saved layout before enabling changes', async t => {
  let attempts = 0;
  const s = setup(t, { invoke: (command, args) => args.action === 'get' && ++attempts === 1 ? Promise.reject(Error('offline')) : undefined });
  await wait(() => s.w.document.getElementById('notice')?.textContent.includes('offline'));
  assert.equal(s.w.document.getElementById('add').disabled, true);
  assert.equal(s.w.document.getElementById('canvasMore').disabled, true);
  s.intervals[0].callback(); await ready(s);
  assert.ok(s.w.document.querySelector('[data-id="one"]'));
  s.w.document.querySelector('[role=switch]').click();
  await wait(() => s.calls.some(call => call.action === 'save'));
  assert.equal(s.calls.find(call => call.action === 'save').payload.boards[0].cards[0].id, 'one');
});
}
module.exports = { setup, ready, wait };
