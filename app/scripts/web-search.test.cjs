const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { test } = require('node:test');
const search = require('../ui/web-search.js');
const ids = rows => Array.from(rows, row => row.id);

test('ranking tiers, stable ties, mixed scripts, directory boundaries and pagination', () => {
  const pages = [
    { id: 'url', title: 'Other', url: 'https://alpha.test' },
    { id: 'note', title: 'Other', note: 'Alpha' },
    { id: 'directory', title: 'Other', path: [{ title: 'Alpha' }, { title: 'Other' }] },
    { id: 'substring', title: 'X Alpha' },
    { id: 'long-prefix', title: 'Alpha long' },
    { id: 'prefix', title: 'Alpha x' },
    { id: 'exact', title: ' ALPHA ' },
    { id: 'exact-tie', title: 'alpha' },
    { id: 'mixed', title: 'GitHub中文 工具' },
    { id: 'breadcrumb', title: 'Help', breadcrumb: 'Alpha / Help' }
  ];
  const index = search.createWebPageIndex(pages);
  const expected = ['exact', 'exact-tie', 'prefix', 'long-prefix', 'substring', 'note', 'directory', 'breadcrumb', 'url'];
  assert.deepEqual(ids(index.search('alpha', 100)), expected);
  assert.deepEqual(ids(index.search(' ALPHA ', 3, 3)), expected.slice(3, 6));
  assert.deepEqual(ids(index.search('alpha', 2, 8)), ['url']);
  assert.deepEqual(index.search('alpha', 12, 99), []);
  assert.deepEqual(ids(index.search('github 中文 中文')), ['mixed']);
  assert.deepEqual(ids(index.search('alpha missing')), []);
  assert.deepEqual(ids(index.search('alpha', 100)), expected);
  assert.deepEqual(ids(index.search(' / - ', 100)), ids(pages));
  assert.deepEqual(ids(index.search(' ', 3, 2)), ids(pages.slice(2, 5)));
  assert.deepEqual(ids(index.search('alpha', -1, -1)), ['exact']);
  const returned = index.search('alpha');
  returned.reverse();
  assert.deepEqual(ids(index.search('alpha', 100)), expected);
  const crossFields = search.createWebPageIndex([
    { id: 'both-url', title: 'Other', url: 'https://alpha.beta.test' },
    { id: 'one-url', title: 'Alpha', url: 'https://beta.test' },
    { id: 'both-context', title: 'Other', note: 'alpha beta' },
    { id: 'one-context', title: 'Alpha', breadcrumb: 'Beta / Alpha' },
    { id: 'all-title', title: 'beta alpha' },
    { id: 'exclude-leaf', title: 'Other', path: [{ title: 'Alpha' }, { title: 'Beta' }] }
  ]);
  assert.deepEqual(ids(crossFields.search('alpha beta')), ['all-title', 'one-context', 'both-context', 'one-url', 'both-url']);
});

function adapter(runtime, initial, deferred) {
  const events = new Map();
  let config = initial;
  let frequent = 'one';
  const window = { FlowHubWebSearch: search };
  if (runtime === 'tauri') window.__TAURI__ = {
    core: { invoke: async (command, args) => {
      if (command === 'get_config') return deferred ? deferred : config;
      if (command === 'save_config') { config = args.config; return { ok: true, config }; }
      if (command === 'search_usage') return { frequent: [{ id: frequent }], recent: [] };
      if (command === 'activate_target') { frequent = args.payload.id; return { ok: true }; }
      throw Error(command);
    } },
    event: { listen: (name, fn) => { events.set(name, fn); return Promise.resolve(() => {}); } }
  };
  const context = vm.createContext({ window, document: { documentElement: { dataset: {} }, getElementById: () => null },
    location: { pathname: '/search.html' }, console,
    fetch: async url => ({ ok: true, json: async () => url === '/plugins.json' ? [{ id: 'web' }, { id: 'app' }] : config }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, `../ui/${runtime}-adapter.js`), 'utf8'), context);
  return { api: window.weborg, events };
}
const config = (directory, title = 'Alpha', enabled = true) => ({ plugins: { web: { enabled, settings: { items: [
  { id: 'folder', title: directory, children: [{ id: 'one', title, url: 'https://one.test' }, { id: 'two', title: 'Alpha two', url: 'https://two.test' }] }
] } } } });

for (const runtime of ['tauri', 'browser']) test(`${runtime}: query and scope changes preserve independent web pagination`, async () => {
  const { api } = adapter(runtime, config('Folder'));
  const run = (query, offset = 0, scope = 'web') => api.pluginSearch('web', { query, offset, limit: 1, scope });
  assert.deepEqual(ids(await run('alpha')), ['one']);
  assert.deepEqual(ids(await run('missing')), []);
  assert.deepEqual(ids(await run('alpha', 1, 'all')), ['two']);
  assert.deepEqual(ids(await run('alpha', 0, 'web')), ['one']);
});

test('native: save, directory rename/location switch, disabling, and usage updates cannot leave stale results', async () => {
  const { api, events } = adapter('tauri', config('Obsolete folder'));
  const run = query => api.pluginSearch('web', { query });
  assert.equal((await run('obsolete')).length, 2);
  await api.saveConfig(config('New folder', 'Changed'));
  assert.deepEqual(ids(await run('obsolete')), []);
  assert.deepEqual(ids(await run('changed')), ['one']);
  events.get('flowhub:config')({ payload: { config: config('Other storage', 'Switched') } });
  assert.deepEqual(ids(await run('changed')), []);
  assert.deepEqual(ids(await run('switched')), ['one']);
  let updates = 0;
  api.onUsageUpdated(() => updates++);
  const before = ids(await run('other'));
  await api.pluginAction('web', 'activate', { id: 'two' });
  events.get('flowhub:usage-updated')();
  assert.equal(updates, 2);
  assert.deepEqual(ids((await api.searchUsage('web')).frequent), ['two']);
  assert.deepEqual(ids(await run('other')), before);
  events.get('flowhub:config')({ payload: config('Disabled', 'Alpha', false) });
  await assert.rejects(run('alpha'), /未启用/);
  events.get('flowhub:config')({ payload: config('Enabled') });
  assert.deepEqual(ids(await run('alpha')), ['one', 'two']);
});

test('native: config event wins over initial get_config still in flight', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { api, events } = adapter('tauri', null, pending);
  const read = api.getConfig();
  events.get('flowhub:config')({ payload: config('New', 'Fresh') });
  resolve(config('Old', 'Stale'));
  await read;
  assert.deepEqual(ids(await api.pluginSearch('web', { query: 'fresh' })), ['one']);
  assert.deepEqual(ids(await api.pluginSearch('web', { query: 'stale' })), []);
});
