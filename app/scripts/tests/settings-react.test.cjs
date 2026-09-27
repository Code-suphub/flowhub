const { test } = require('node:test'), assert = require('node:assert/strict');
const h = require('./settings-harness.test.cjs');
const { Settings } = require('../../src/settings/index.tsx');
test('compact settings groups sources and data; unsupported updates have no progress bar', async () => {
  const { store } = await h.loaded({ getUpdateState: async () => ({ status:'unsupported', currentVersion:'0.1.0', percent:0 }) }, true);
  const view = await h.mount(Settings, { store });
  const select = async id => h.click(view.container.querySelector(`#tab-${id}`));
  await select('search');
  const sources = [...view.container.querySelectorAll('.settings-source-row')];
  assert.equal(sources.length, store.snapshot().plugins.length);
  for (const source of sources) assert.equal(source.querySelectorAll('[role=switch]').length,1);
  await select('data');
  assert.equal(view.container.querySelectorAll('.settings-data-panel > .settings-group').length,4);
  const path = view.container.querySelector('[aria-label="路径"]');
  assert.ok(path); assert.equal(path.closest('.settings-row').querySelectorAll('.settings-row').length,0);
  await select('updates');
  assert.match(view.container.querySelector('[role=tabpanel]').textContent,/当前环境不支持更新/);
  assert.equal(view.container.querySelector('progress'),null);
  await h.act(async () => store.patch({update:{status:'downloading',percent:42}}));
  assert.equal(view.container.querySelector('progress').value,42);
  await view.unmount(); store.dispose();
});
test('all settings sections mount, tabs switch with Arrow keys/Home/End in read-only preview', async () => {
  const { store, writes } = await h.loaded({}, true), view = await h.mount(Settings, { store });
  const tabs = [...view.container.querySelectorAll('[role=tab]')]; assert.equal(tabs.length, 7);
  await h.key(tabs[0], 'ArrowRight'); assert.equal(tabs[1].getAttribute('aria-selected'), 'true'); assert.equal(document.activeElement, tabs[1]);
  await h.key(tabs[1], 'End'); assert.equal(tabs[6].getAttribute('aria-selected'), 'true');
  await h.key(tabs[6], 'Home'); assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  await h.key(tabs[0], 'ArrowLeft'); assert.equal(tabs[6].getAttribute('aria-selected'), 'true');
  for (const tab of tabs) { await h.click(tab); assert.ok(view.container.querySelector(`#panel-${tab.id.slice(4)}`)); }
  assert.equal(writes.length, 0); assert.equal(h.button(view.container, '保存').disabled, true);
  await view.unmount(); store.dispose();
});
test('tools use a compact grid and memos keep navigation separate from details', async () => {
  const {store}=await h.loaded({},true),view=await h.mount(Settings,{store});
  await h.click(h.button(view.container,'工具'));
  assert.equal(view.container.querySelectorAll('.settings-tools-grid .settings-row').length,Object.keys(h.model.tools).length);
  await h.click(h.button(view.container,'备忘录'));
  assert.ok(view.container.querySelector('.settings-memo-workspace .settings-memo-nav .settings-memo-tree'));
  assert.ok(view.container.querySelector('.settings-memo-workspace .settings-memo-detail'));
  await view.unmount();store.dispose();
});
test('read-only network adapter can inspect options without changing its value', async () => {
  const { store, writes } = await h.loaded({}, true), view = await h.mount(Settings, { store });
  await h.click(view.container.querySelector('#tab-network'));
  const before = store.snapshot().config.plugins.tools.settings.proxyAdapter;
  const select = view.container.querySelector('[aria-label="代理检测适配器"]');
  assert.equal(select.disabled, false);
  await h.click(select);
  const options = [...document.querySelectorAll('[role=option]')];
  assert.equal(options.length, 4);
  const mihomo = options.find(option => option.textContent === 'Mihomo');
  await h.act(async () => { mihomo.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); mihomo.click(); });
  assert.equal(store.snapshot().config.plugins.tools.settings.proxyAdapter, before);
  assert.equal(writes.length, 0);
  await view.unmount(); store.dispose();
});
test('native entrypoints queue addUrl until loading, deduplicate URLs, reject protocols and clean subscriptions', async () => {
  const env = h.environment(); window.history.replaceState({}, '', '/settings.html?addUrl=https%3A%2F%2Fnew.example%2F');
  const store = new h.SettingsStore(), selections = []; const { bindNativeSettings } = require('../../src/settings/native.ts');
  const dispose = bindNativeSettings(store, v => selections.push(v), () => {});
  assert.equal(typeof window.switchModule, 'function'); window.prepareAddWebUrl('https://new.example/');
  await store.load(); await new Promise(r => setImmediate(r));
  assert.equal(h.model.entries(store.snapshot().config.plugins.web.settings.items).filter(e => e.node.url === 'https://new.example/').length, 1);
  assert.ok(selections.includes('web')); window.prepareAddWebUrl('javascript:alert(1)'); await Promise.resolve(); assert.match(store.snapshot().notice, /HTTP/);
  window.switchModule('plugin:sample'); assert.equal(selections.at(-1), 'plugin:sample');
  assert.equal(env.events.config.size, 1); assert.equal(env.events.update.size, 1);
  for (const callback of env.events.update) callback({ status: 'downloaded' }); assert.equal(store.snapshot().update.status, 'downloaded');
  for (const callback of env.events.config) callback(); assert.match(store.snapshot().notice, /外部配置/);
  dispose(); assert.equal(env.events.config.size, 0); assert.equal(env.events.update.size, 0); assert.equal(window.prepareAddWebUrl, undefined); store.dispose();
});
test('update query and runMenuUpdate check/install by state; repeated calls and dirty edits cannot install', async () => {
  let checked = 0, installs = 0, status = 'idle';
  const env = h.environment({ getUpdateState: async () => ({ status }), checkForUpdates: async () => { checked++; return { ok: true, state: { status: 'available' } }; }, downloadAndInstallUpdate: async () => { installs++; return { ok: true, state: { status: 'installing' } }; } });
  window.history.replaceState({}, '', '/settings.html?update=1'); const store = new h.SettingsStore();
  const { bindNativeSettings } = require('../../src/settings/native.ts'); let section;
  const dispose = bindNativeSettings(store, () => {}, v => { section = v; }); await store.load(); await new Promise(r => setImmediate(r));
  assert.equal(checked, 1); assert.equal(section, 'updates'); status = 'available'; await Promise.all([window.runMenuUpdate(), window.runMenuUpdate()]); assert.equal(installs, 1);
  store.edit(c => { c.core.hotkey = 'F1'; }); await window.runMenuUpdate(); assert.equal(installs, 1); assert.match(store.snapshot().notice, /保存/);
  dispose(); assert.equal(env.events.update.size, 0); store.dispose();
});
test('settings rendering has no legacy DOM renderer, and HTML uses the file-compatible single bundle', () => {
  const html = h.fs.readFileSync(h.path.join(__dirname, '../../ui/settings.html'), 'utf8');
  assert.match(html, /id="settings-root"/); assert.match(html, /react\/host.js/); assert.match(html, /react\/host.css/); assert.doesNotMatch(html, /settings\/settings.js|collection-layout|settings-appearance/);
  for (const name of h.fs.readdirSync(h.path.join(__dirname, '../../src/settings'))) if (/\.(tsx?|css)$/.test(name)) assert.doesNotMatch(h.fs.readFileSync(h.path.join(__dirname, '../../src/settings', name), 'utf8'), /innerHTML|dangerouslySetInnerHTML/);
});
test('all core tabs use shared tooltip triggers', async () => {
  const { store } = await h.loaded(), view = await h.mount(Settings, { store });
  const tabs = [...view.container.querySelectorAll('[role=tab]')];
  assert.ok(tabs.every(tab => tab.hasAttribute('data-base-ui-tooltip-trigger')));
  await view.unmount(); store.dispose();
});
test('module queries select requested section and reject unknown module values', async () => {
  const { bindNativeSettings } = require('../../src/settings/native.ts');
  for (const [query, expected] of [['clipboard','clipboard'], ['not-a-module','core']]) { const { store } = await h.loaded(); window.history.replaceState({}, '', '/settings.html?module='+query); let module; const dispose = bindNativeSettings(store, v => { module=v; }, () => {}); assert.equal(module, expected); dispose(); store.dispose(); }
});
test('theme Select writes shared theme preference and follows host theme events', async () => {
  h.environment(); let theme = 'system'; window.FlowHubTheme = { get: () => theme, set: value => { theme = value; } };
  const { Theme } = require('../../src/settings/Theme.tsx'), view = await h.mount(Theme, {});
  await h.click(view.container.querySelector('[aria-label="外观主题"]'));
  const dark = [...document.querySelectorAll('[role=option]')].find(option => option.textContent === '深色');
  await h.act(async () => { dark.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); dark.click(); });
  assert.equal(theme, 'dark'); theme='light'; await h.act(async () => window.dispatchEvent(new window.Event('flowhub-theme-change'))); assert.match(view.container.textContent,/浅色/);
  theme='system'; await h.act(async () => window.dispatchEvent(new window.Event('flowhub:theme'))); assert.match(view.container.textContent,/跟随系统/);
  await view.unmount(); delete window.FlowHubTheme;
});
