// Shared in-memory React harness. All native calls and storage are isolated test doubles.
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
require.extensions['.css'] = () => {};
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/settings.html', pretendToBeVisual: true });
global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement; global.Node = dom.window.Node;
global.innerWidth = 1280; global.innerHeight = 800;
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.confirm = () => true;
const React = require('react'), { act } = React, { createRoot } = require('react-dom/client');
const model = require('../../src/settings/model.ts'), { SettingsStore } = require('../../src/settings/store.ts');
const fixture = () => model.normalize({ core: { hotkey: 'Alt+Space' }, plugins: { web: { enabled: true, settings: { items: [{ id: 'a', title: 'A', children: [{ id: 'a1', title: 'A1' }, { id: 'a2', title: 'A2' }] }, { id: 'b', title: 'B' }, { id: 'c', title: 'C', children: [{ id: 'c1', title: 'C1' }] }, { id: 'd', title: 'D' }, { id: 'p', title: 'Page', url: 'https://example.test/' }] } }, memo: { settings: { items: [{ id: 'm1', title: '一', category: '编程 / 数据库 / MySQL', content: 'select 1' }, { id: 'm2', title: '二', category: '编程 / 数据库 / PostgreSQL', content: 'select 2' }] } } } });
function environment(overrides = {}, preview = false) {
  document.body.replaceChildren(); localStorage.clear(); window.history.replaceState({}, '', '/settings.html');
  document.documentElement.dataset.weborgRuntime = preview ? 'browser' : 'tauri';
  window.__TAURI__ = preview ? undefined : { core: { invoke: async () => [] } };
  const events = { config: new Set(), update: new Set() }; let config = fixture(); const writes = [];
  window.weborg = {
    getConfig: async () => model.clone(config), listPlugins: async () => ['web', 'app', 'clipboard', 'memo', 'tools'].map(id => ({ id, name: id, available: true })),
    getConfigPathInfo: async () => ({ activePath: '/config/A', configuredPath: '' }), getClipboardStorageInfo: async () => ({ activePath: '/db/A', configuredPath: '' }),
    getUpdateState: async () => ({ status: 'idle', currentVersion: '1.0' }), getDiagnosticsState: async () => ({}), getMenuBarManagementState: async () => ({ trusted: false }), listMenuBarItems: async () => ({ items: [] }), listConfigHistory: async () => ({ entries: [], available: !preview }),
    saveConfig: async value => { writes.push(value); config = model.clone(value); return { ok: true, config }; },
    onConfig: fn => { events.config.add(fn); return () => events.config.delete(fn); }, onUpdateState: fn => { events.update.add(fn); return () => events.update.delete(fn); }, closeSettings: async () => ({}), ...overrides
  };
  window.FlowHubMemoCatalog = { cloneDefaults: () => [{ id: 'builtin', title: '默认', category: '内置', content: 'pwd' }] };
  return { events, writes, setConfig: next => { config = next; } };
}
async function loaded(overrides, preview = false) { const env = environment(overrides, preview), store = new SettingsStore(); await store.load(); return { ...env, store }; }
async function mount(Component, props) { const container = document.createElement('div'); document.body.append(container); const root = createRoot(container); await act(async () => root.render(React.createElement(Component, props))); return { container, root, unmount: async () => { await act(async () => root.unmount()); container.remove(); } }; }
const button = (container, text) => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text);
async function click(element) { if (!element) throw new Error('Missing click target'); await act(async () => element.click()); }
async function key(element, value, extra = {}) { await act(async () => element.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, ...extra }))); }
async function input(element, value) { await act(async () => { const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value); element.dispatchEvent(new window.Event('input', { bubbles: true })); }); }
module.exports = { React, act, fs, path, model, SettingsStore, fixture, environment, loaded, mount, button, click, key, input };
