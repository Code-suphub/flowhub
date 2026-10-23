const { test } = require('node:test'), assert = require('node:assert/strict');
const h = require('./settings-harness.test.cjs');
const { Settings } = require('../../src/settings/index.tsx');
const { Core } = require('../../src/settings/Core.tsx');
test('2FA participates in source sorting and preserves its saved position', async () => {
  const { store } = await h.loaded({ listPlugins: async () => ['app', 'web', 'clipboard', 'memo', 'twofa', 'tools'].map(id => ({ id, name: id, available: true })) });
  const view = await h.mount(Settings, { store });
  await h.click(view.container.querySelector('#tab-search'));
  const grip = view.container.querySelector('[data-source=twofa] .settings-search-grip');
  assert.ok(grip);
  for (let i = 0; i < 4; i++) await h.key(grip, 'ArrowUp', { altKey: true });
  assert.deepEqual(store.snapshot().config.core.searchResultOrder, ['twofa', 'app', 'web', 'clipboard', 'memo']);
  assert.equal(view.container.querySelector('.settings-search-item').dataset.source, 'twofa');
  await h.act(async () => store.save());
  await view.unmount();
  const remount = await h.mount(Settings, { store });
  await h.click(remount.container.querySelector('#tab-search'));
  assert.equal(remount.container.querySelector('.settings-search-item').dataset.source, 'twofa');
  assert.equal(remount.container.querySelector('[data-source=tools] .settings-search-grip'), null);
  await remount.unmount(); store.dispose();
});
const pointer = (type, element, x, y, pointerId = 1) => { const event = new window.Event(type, { bubbles:true, cancelable:true }); Object.assign(event, { pointerId, pointerType:'mouse', button:0, clientX:x, clientY:y }); element.dispatchEvent(event); };
test('compact settings groups sources and data; unsupported updates have no progress bar', async () => {
  const { store } = await h.loaded({ getUpdateState: async () => ({ status:'unsupported', currentVersion:'0.1.0', percent:0 }) }, true);
  const view = await h.mount(Settings, { store });
  const select = async id => h.click(view.container.querySelector(`#tab-${id}`));
  await select('search');
  const sources = [...view.container.querySelectorAll('.settings-search-item')];
  assert.equal(sources.length, store.snapshot().plugins.length);
  for (const source of sources) assert.equal(source.querySelectorAll('[role=switch]').length,1);
  assert.deepEqual(sources.slice(0, 4).map(source => source.dataset.source), ['app', 'web', 'clipboard', 'memo']);
  assert.equal(view.container.querySelectorAll('.settings-search-item .settings-search-grip').length, 4);
  assert.equal(view.container.querySelector('.settings-search-columns'), null);
  assert.equal(view.container.querySelector('.settings-search-item[data-source=tools] .settings-search-rank').textContent, '');
  for (const grip of view.container.querySelectorAll('.settings-search-grip')) assert.equal(grip.textContent.trim(), '⠿');
  assert.equal(view.container.querySelectorAll('.settings-search-item .fh-help').length, 0);
  assert.ok(view.container.querySelector('.settings-search-item[data-source=app] [aria-label="应用范围键"]'));
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
test('search source row keeps priority, toggle, and shortcut together; keyboard reorder updates config', async () => {
  const { store } = await h.loaded(), view = await h.mount(Settings, { store });
  await h.click(view.container.querySelector('#tab-search'));
  const rows = () => [...view.container.querySelectorAll('.settings-search-item')];
  const initial = ['app', 'web', 'clipboard', 'memo'];
  assert.deepEqual(rows().slice(0, 4).map(row => row.dataset.source), initial);
  await h.key(rows()[0].querySelector('.settings-search-grip'), 'ArrowDown', { altKey: true });
  assert.deepEqual(store.snapshot().config.core.searchResultOrder.slice(0, 2), [initial[1], initial[0]]);
  assert.deepEqual(rows().slice(0, 2).map(row => row.dataset.source), [initial[1], initial[0]]);
  const source = rows()[1], target = rows()[0], handle = source.querySelector('.settings-search-grip');
  source.getBoundingClientRect = () => ({ left:10, top:100, width:500, height:62 });
  target.getBoundingClientRect = () => ({ left:10, top:0, width:500, height:62 });
  const previousElementFromPoint = document.elementFromPoint; document.elementFromPoint = () => target;
  await h.act(async () => { pointer('pointerdown', handle, 20, 120); pointer('pointermove', window, 20, 10); });
  assert.equal(target.dataset.dropPosition, 'before');
  const ghost = document.querySelector('.settings-search-drag-preview');
  assert.ok(ghost); assert.equal(ghost.inert, true); assert.equal(ghost.getAttribute('aria-hidden'), 'true');
  assert.equal(ghost.querySelector('[data-source]'), null); assert.equal(source.getAttribute('data-drag-source'), 'true');
  await h.act(async () => pointer('pointerup', window, 20, 10));
  document.elementFromPoint = previousElementFromPoint;
  assert.deepEqual(store.snapshot().config.core.searchResultOrder, initial);
  const app = view.container.querySelector('.settings-search-item[data-source=app]');
  assert.ok(app.querySelector('[role=switch]'));
  assert.ok(app.querySelector('[aria-label="应用范围键"]'));
  await h.click(app.querySelector('[role=switch]'));
  assert.equal(store.snapshot().config.plugins.app.enabled, false);
  await h.click(app.querySelector('[aria-label="应用范围键"]'));
  await h.key(app.querySelector('[aria-label="应用范围键"]'), '9', { code: 'Digit9' });
  assert.equal(store.snapshot().config.core.scopeShortcuts.app, '9');
  await view.unmount(); store.dispose();
});
test('read-only search preview allows temporary drag and keyboard sorting without enabling settings', async () => {
  const { store, writes } = await h.loaded({}, true), view = await h.mount(Settings, { store });
  await h.click(view.container.querySelector('#tab-search'));
  const rows = () => [...view.container.querySelectorAll('.settings-search-item')];
  const initial = rows().slice(0, 4).map(row => row.dataset.source);
  const savedConfig = JSON.stringify(store.snapshot().config);
  const grip = rows()[1].querySelector('.settings-search-grip');
  assert.equal(grip.disabled, false);
  assert.equal(grip.draggable, false);
  const source = rows()[1], target = rows()[0];
  source.getBoundingClientRect = () => ({ left:10, top:100, width:500, height:62 });
  target.getBoundingClientRect = () => ({ left:10, top:0, width:500, height:62 });
  const previousElementFromPoint = document.elementFromPoint; document.elementFromPoint = () => target;
  await h.act(async () => { pointer('pointerdown', grip, 20, 120, 2); pointer('pointermove', window, 20, 10, 2); });
  assert.equal(target.dataset.dropPosition, 'before');
  const ghost = document.querySelector('.settings-search-drag-preview');
  assert.ok(ghost); assert.equal(ghost.inert, true); assert.equal(ghost.getAttribute('aria-hidden'), 'true');
  assert.equal(ghost.querySelector('[data-source]'), null);
  await h.act(async () => pointer('pointerup', window, 20, 10, 2));
  document.elementFromPoint = previousElementFromPoint;
  assert.deepEqual(rows().slice(0, 4).map(row => row.dataset.source), [initial[1], initial[0], ...initial.slice(2)]);
  assert.equal(JSON.stringify(store.snapshot().config), savedConfig);
  assert.equal(writes.length, 0);
  const toolsRow = view.container.querySelector('.settings-search-item[data-source=tools]');
  const beforeInvalidDrop = rows().map(row => row.dataset.source);
  document.elementFromPoint = () => toolsRow;
  await h.act(async () => { pointer('pointerdown', rows()[0].querySelector('.settings-search-grip'), 20, 120, 3); pointer('pointermove', window, 20, 10, 3); });
  assert.equal(toolsRow.dataset.dropPosition, undefined);
  await h.act(async () => pointer('pointerup', window, 20, 10, 3));
  document.elementFromPoint = previousElementFromPoint;
  assert.deepEqual(rows().map(row => row.dataset.source), beforeInvalidDrop);
  assert.equal(JSON.stringify(store.snapshot().config), savedConfig);
  assert.equal(writes.length, 0);
  const app = view.container.querySelector('.settings-search-item[data-source=app]');
  assert.equal(app.querySelector('[role=switch]').getAttribute('aria-disabled'), 'true');
  assert.equal(app.querySelector('[aria-label="应用范围键"]').disabled, true);
  assert.equal(view.container.querySelector('[aria-label="全部结果范围键"]').disabled, true);
  await h.key(app.querySelector('.settings-search-grip'), 'ArrowDown', { altKey: true });
  assert.equal(JSON.stringify(store.snapshot().config), savedConfig);
  assert.equal(writes.length, 0);
  await view.unmount();
  const remounted = await h.mount(Settings, { store });
  await h.click(remounted.container.querySelector('#tab-search'));
  assert.deepEqual([...remounted.container.querySelectorAll('.settings-search-item')].slice(0, 4).map(row => row.dataset.source), initial);
  await remounted.unmount(); store.dispose();
});
test('search pointer drag clears its overlay on cancel, Escape, tab change, and unmount', async () => {
  const { store, writes } = await h.loaded({}, true), view = await h.mount(Settings, { store });
  await h.click(view.container.querySelector('#tab-search'));
  const rows = [...view.container.querySelectorAll('.settings-search-item')], source = rows[0], target = rows[1];
  source.getBoundingClientRect = () => ({ left:10, top:0, width:500, height:62 });
  target.getBoundingClientRect = () => ({ left:10, top:62, width:500, height:62 });
  const previousElementFromPoint = document.elementFromPoint; document.elementFromPoint = () => target;
  const begin = async id => h.act(async () => { pointer('pointerdown', source.querySelector('.settings-search-grip'), 20, 20, id); pointer('pointermove', window, 20, 80, id); });
  const assertCleared = () => { assert.equal(document.querySelector('.settings-search-drag-preview'), null); assert.equal(view.container.querySelector('[data-drag-source]'), null); assert.equal(view.container.querySelector('[data-drop-position]'), null); assert.equal(document.body.classList.contains('settings-search-dragging'), false); };
  await begin(4); await h.act(async () => pointer('pointercancel', window, 20, 80, 4)); assertCleared();
  await begin(5); await h.act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key:'Escape', bubbles:true }))); assertCleared();
  await begin(6); await h.click(view.container.querySelector('#tab-general')); assertCleared();
  await h.click(view.container.querySelector('#tab-search')); await begin(7); await view.unmount();
  assert.equal(document.querySelector('.settings-search-drag-preview'), null);
  assert.equal(document.body.classList.contains('settings-search-dragging'), false);
  document.elementFromPoint = previousElementFromPoint;
  assert.equal(store.dirty, false); assert.equal(writes.length, 0); store.dispose();
});
test('unavailable search source shows its reason inline without a redundant help popup', async () => {
  const { store } = await h.loaded({ listPlugins: async () => [
    { id: 'app', name: '应用', settingsHint: '启动设置', available: false, reason: '当前系统不支持应用扫描' },
    { id: 'web', name: '网页', available: true }
  ] }), view = await h.mount(Settings, { store });
  await h.click(view.container.querySelector('#tab-search'));
  const row = view.container.querySelector('.settings-search-item[data-source=app]');
  assert.match(row.textContent, /当前系统不支持应用扫描/);
  assert.doesNotMatch(row.textContent, /启动设置/);
  assert.equal(row.querySelector('.fh-help'), null);
  assert.equal(row.querySelector('[role=switch]').getAttribute('aria-disabled'), 'true');
  await view.unmount(); store.dispose();
});
test('five settings sections mount, tabs switch with Arrow keys/Home/End in read-only preview', async () => {
  const { store, writes } = await h.loaded({}, true), view = await h.mount(Settings, { store });
  const tabs = [...view.container.querySelectorAll('[role=tab]')]; assert.deepEqual(tabs.map(tab => tab.id.slice(4)), ['general','search','menubar','data','updates']);
  assert.equal(tabs.length, 5);
  await h.key(tabs[0], 'ArrowRight'); assert.equal(tabs[1].getAttribute('aria-selected'), 'true'); assert.equal(document.activeElement, tabs[1]);
  await h.key(tabs[1], 'End'); assert.equal(tabs[4].getAttribute('aria-selected'), 'true');
  await h.key(tabs[4], 'Home'); assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  await h.key(tabs[0], 'ArrowLeft'); assert.equal(tabs[4].getAttribute('aria-selected'), 'true');
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
test('settings sidebar separates built-ins from plugins and preview keeps canvas control read-only', async () => {
  const {store}=await h.loaded({},true),view=await h.mount(Settings,{store});
  const groups=[...view.container.querySelectorAll('.settings-nav-group')];
  assert.deepEqual(groups.map(group=>group.querySelector('.settings-nav-heading').textContent),['内置功能','插件']);
  assert.ok(h.button(groups[0],'通用设置'));
  assert.ok(h.button(groups[1],'插件市场'));
  await h.click(h.button(groups[1],'桌面组件'));
  assert.equal(view.container.querySelector('.settings-canvas [role=switch]').getAttribute('aria-disabled'),'true');
  assert.equal(h.button(view.container,'打开桌面组件').disabled,true);
  await view.unmount();store.dispose();
});
test('native canvas setting saves view-only immediately and opens the widget surface', async () => {
  const {store}=await h.loaded();
  const calls=[];
  window.__TAURI__.core.invoke=async (command,args)=>{
    calls.push({command,...args});
    if(args.action==='get') return {layout:{viewOnly:false}};
    return {};
  };
  const view=await h.mount(Settings,{store});
  await h.click(h.button(view.container,'桌面组件'));
  const toggle=view.container.querySelector('.settings-canvas [role=switch][aria-label="仅查看桌面组件"]');
  assert.equal(toggle.getAttribute('aria-checked'),'false');
  await h.click(toggle);
  assert.deepEqual(calls.find(call=>call.action==='setViewOnly').payload,{enabled:true});
  assert.equal(toggle.getAttribute('aria-checked'),'true');
  await h.act(async () => window.dispatchEvent(new window.CustomEvent('flowhub:canvas-view-only',{detail:false})));
  assert.equal(toggle.getAttribute('aria-checked'),'false');
  await h.click(h.button(view.container,'打开桌面组件'));
  assert.ok(calls.some(call=>call.action==='open'));
  await view.unmount();store.dispose();
});
test('read-only general keeps adapter options inspectable while shortcuts and notifications stay disabled', async () => {
  const { store, writes } = await h.loaded({}, true), view = await h.mount(Settings, { store });
  await h.click(view.container.querySelector('#tab-general'));
  const before = store.snapshot().config.plugins.tools.settings.proxyAdapter;
  const select = view.container.querySelector('[aria-label="代理检测适配器"]');
  assert.equal(select.disabled, false);
  assert.equal(view.container.querySelector('[aria-label="唤出 FlowHub"]').matches(':disabled'), true);
  assert.ok([...view.container.querySelectorAll('.settings-core-group[aria-labelledby="general-notifications-heading"] [role=switch]')].every(control => control.getAttribute('aria-disabled') === 'true'));
  assert.equal(h.button(view.container, '发送测试通知').matches(':disabled'), true);
  await h.click(select);
  const options = [...document.querySelectorAll('[role=option]')];
  assert.equal(options.length, 4);
  const mihomo = options.find(option => option.textContent === 'Mihomo');
  await h.act(async () => { mihomo.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); mihomo.click(); });
  assert.equal(store.snapshot().config.plugins.tools.settings.proxyAdapter, before);
  assert.equal(writes.length, 0);
  await view.unmount(); store.dispose();
});
test('legacy network and notifications section names resolve to the general tab', async () => {
  const { store } = await h.loaded({}, true);
  for (const section of ['network','notifications']) {
    const view = await h.mount(Core, { store, section, onSection: () => {} });
    assert.equal(view.container.querySelector('#tab-general').getAttribute('aria-selected'), 'true');
    assert.ok(view.container.querySelector('#panel-general [aria-label="代理检测适配器"]'));
    assert.ok(view.container.querySelector('#panel-general [role=switch]'));
    await view.unmount();
  }
  store.dispose();
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
test('core tabs do not repeat their labels in hover descriptions', async () => {
  const { store } = await h.loaded(), view = await h.mount(Settings, { store });
  const tabs = [...view.container.querySelectorAll('[role=tab]')];
  assert.ok(tabs.every(tab => !tab.hasAttribute('data-base-ui-tooltip-trigger')));
  await view.unmount(); store.dispose();
});
test('module queries select requested section and reject unknown module values', async () => {
  const { bindNativeSettings } = require('../../src/settings/native.ts');
  for (const [query, expected] of [['clipboard','clipboard'], ['canvas','canvas'], ['not-a-module','core']]) { const { store } = await h.loaded(); window.history.replaceState({}, '', '/settings.html?module='+query); let module; const dispose = bindNativeSettings(store, v => { module=v; }, () => {}); assert.equal(module, expected); dispose(); store.dispose(); }
});
test('theme Select writes shared theme preference and follows host theme events', async () => {
  h.environment(); let theme = 'system'; window.FlowHubTheme = { get: () => theme, set: value => { theme = value; } };
  const { Theme } = require('../../src/settings/Theme.tsx'), view = await h.mount(Theme, {});
  await h.key(view.container.querySelector('[aria-label="外观主题"]'), 'ArrowDown');
  const dark = [...document.querySelectorAll('[role=option]')].find(option => option.textContent === '深色');
  await h.act(async () => { dark.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); dark.click(); });
  assert.equal(theme, 'dark'); theme='light'; await h.act(async () => window.dispatchEvent(new window.Event('flowhub-theme-change'))); assert.match(view.container.textContent,/浅色/);
  theme='system'; await h.act(async () => window.dispatchEvent(new window.Event('flowhub:theme'))); assert.match(view.container.textContent,/跟随系统/);
  await view.unmount(); delete window.FlowHubTheme;
});

test('menu-bar settings expose real sections and names, retain failed scans, and preserve item visibility actions', async () => {
  let failure=false, rejectMove=true;const moves=[];
  const items=[
    {windowId:1,displayName:'主图标',ownerName:'进程',section:'visible',hideable:true},
    {windowId:2,accessibilityLabel:'隐藏图标',section:'alwaysHidden',hideable:true},
    {windowId:3,title:'未知图标',section:'future',hideable:true},
    {windowId:4,title:'固定图标',section:'visible',hideable:false},
  ];
  const {store}=await h.loaded({
    getMenuBarManagementState:async()=>({trusted:true,supported:true}),
    listMenuBarItems:async()=>failure?{ok:false,reason:'扫描失败'}:{ok:true,items},
    setMenuBarItemHidden:async(id,hidden)=>{moves.push([id,hidden]);if(rejectMove)return {ok:false,reason:'鼠标正在使用中'};items.find(item=>item.windowId===id).section=hidden?'alwaysHidden':'hidden';return {ok:true};},
  });
  store.edit(c=>{c.core.menuBar.organizerEnabled=true;});
  const view=await h.mount(Core,{store,section:'menubar',onSection:()=>{}});
  await h.act(async()=>store.refreshMenu());
  const row=name=>[...view.container.querySelectorAll('.settings-row')].find(node=>node.textContent.includes(name));
  assert.match(row('主图标').textContent,/常显区/);assert.match(row('隐藏图标').textContent,/始终隐藏区.*恢复显示/);
  assert.match(row('未知图标').textContent,/分区未知/);assert.equal(row('未知图标').querySelector('button').disabled,true);
  assert.match(row('固定图标').textContent,/常显区.*系统固定/);assert.equal(row('固定图标').querySelector('button').disabled,true);
  await h.click(row('主图标').querySelector('button'));
  assert.match(store.snapshot().notice,/鼠标正在使用中/);assert.equal(store.snapshot().error,true);
  assert.deepEqual(moves,[[1,true]]);
  const previous=store.snapshot().menuItems;failure=true;
  await h.act(async()=>store.run(()=>store.refreshMenu()));
  assert.equal(store.snapshot().menuItems,previous);assert.match(store.snapshot().notice,/扫描失败/);
  failure=false;rejectMove=false;await h.click(row('隐藏图标').querySelector('button'));
  assert.deepEqual(moves,[[1,true],[2,false]]);assert.match(row('隐藏图标').textContent,/随箭头展开／收起/);
  await view.unmount();store.dispose();
});
