const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { setup, wait, delay } = require('./search-react-harness.cjs');
const app = title => ({ kind: 'app', title, path: `/Applications/${title}.app` });
const appSearch = source => (id, args, fixtures) => id === 'app'
  ? source().filter(item => item.title.toLowerCase().includes(args.query.toLowerCase())).slice(args.offset || 0, (args.offset || 0) + args.limit)
  : args.offset ? [] : fixtures[id] || [];

test('the native adapter delivers catalog events and rejects stale icon cache writes', async () => {
  const listeners = {}, pending = [];
  const w = { __TAURI__: {
    core: { invoke: (name) => {
      assert.equal(name, 'load_application_icons');
      return new Promise(resolve => pending.push(resolve));
    } },
    event: { listen: async (name, fn) => { listeners[name] = fn; return () => delete listeners[name]; } }
  } };
  const context = vm.createContext({ window: w, document: { documentElement: { dataset: {} }, getElementById: () => null }, location: { pathname: '/search.html' } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../ui/shared/tauri-adapter.js'), 'utf8'), context);
  let delivered = 0;
  const off = w.weborg.onApplicationsUpdated(() => delivered++);
  const appPath = '/Applications/Test.app';
  const old = w.weborg.loadAppIcons([appPath]);
  listeners['flowhub:applications-updated']();
  const fresh = w.weborg.loadAppIcons([appPath]);
  pending[1]({ [appPath]: 'new-icon' }); await fresh;
  pending[0]({ [appPath]: 'old-icon' }); await old;
  assert.equal((await w.weborg.loadAppIcons([appPath]))[appPath], 'new-icon');
  assert.equal(pending.length, 2);
  assert.equal(delivered, 1);
  off(); listeners['flowhub:applications-updated']();
  assert.equal(delivered, 1);
});

test('installed and removed apps update an open search without changing its query or scope', async t => {
  let apps = [app('Original')];
  const { w, q, input, scope, events } = await setup(t, { search: appSearch(() => apps) });
  await scope('app'); await input('New');
  assert.doesNotMatch(w.document.getElementById('results').textContent, /New App/);
  apps = [...apps, app('New App')];
  events.onApplicationsUpdated();
  await wait(() => w.document.getElementById('results').textContent.includes('New App'));
  assert.equal(q.value, 'New');
  assert.ok(w.document.querySelector('[data-scope="app"]').classList.contains('active'));
  apps = [app('Original')]; events.onApplicationsUpdated();
  await wait(() => !w.document.getElementById('results').textContent.includes('New App'));
  assert.equal(q.value, 'New');
});

test('an update received in another scope refreshes the next-show application cache', async t => {
  let apps = [app('Original')];
  const { w, q, scope, input, calls, events } = await setup(t, { search: appSearch(() => apps) });
  await scope('web'); await input('Website');
  apps = [app('Installed')]; events.onApplicationsUpdated();
  await wait(() => calls.filter(call => call[0] === 'search' && call[1] === 'app').length >= 2);
  await delay(30);
  assert.equal(q.value, 'Website');
  assert.match(w.document.getElementById('results').textContent, /Website/);
  w.prepareForShow(); await scope('app');
  await wait(() => w.document.getElementById('results').textContent.includes('Installed'));
  assert.doesNotMatch(w.document.getElementById('results').textContent, /Original/);
});

test('overlapping index notifications discard stale catalog responses and preserve newer input', async t => {
  let apps = [app('Original')], hold = false, resolveOld;
  const normal = appSearch(() => apps);
  const { w, q, scope, input, events } = await setup(t, { search: (id, args, fixtures) => {
    if (id === 'app' && args.query === '' && hold) {
      hold = false;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    return normal(id, args, fixtures);
  } });
  await scope('app');
  hold = true; events.onApplicationsUpdated();
  await wait(() => Boolean(resolveOld));
  apps = [app('Newest')]; events.onApplicationsUpdated();
  await input('Newest');
  resolveOld([app('Stale')]);
  await wait(() => w.document.getElementById('results').textContent.includes('Newest'));
  await delay(50);
  assert.equal(q.value, 'Newest');
  assert.doesNotMatch(w.document.getElementById('results').textContent, /Stale/);
  w.prepareForShow();
  assert.match(w.document.getElementById('results').textContent, /Newest/);
  assert.doesNotMatch(w.document.getElementById('results').textContent, /Stale/);
});

test('catalog failures retain visible content and retry when the launcher is reopened', async t => {
  let apps = [app('Original')], fail = false;
  const normal = appSearch(() => apps);
  const { w, scope, events } = await setup(t, { search: (id, args, fixtures) => {
    if (id === 'app' && fail) return Promise.reject(new Error('temporary IPC error'));
    return normal(id, args, fixtures);
  } });
  await scope('app');
  fail = true; events.onApplicationsUpdated(); await delay(30);
  assert.match(w.document.getElementById('results').textContent, /Original/);
  fail = false; apps = [app('Recovered')]; w.prepareForShow();
  await wait(() => w.document.getElementById('results').textContent.includes('Recovered'));
});

test('catalog refresh retains keyboard selection and scroll position, and unsubscribes on unmount', async t => {
  let apps = Array.from({ length: 12 }, (_, i) => app(`App ${i}`));
  const { w, scope, key, events, unmount } = await setup(t, { search: appSearch(() => apps) });
  await scope('app'); key('ArrowDown');
  await wait(() => w.document.querySelector('.result.active h3')?.textContent === 'App 1');
  const selected = w.document.querySelector('.result.active h3')?.textContent;
  const results = w.document.getElementById('results'); results.scrollTop = 100;
  apps = [app('Added'), ...apps]; events.onApplicationsUpdated();
  await wait(() => results.textContent.includes('Added'));
  assert.equal(w.document.querySelector('.result.active h3')?.textContent, selected);
  assert.equal(results.scrollTop, 100);
  unmount();
  assert.equal(events.onApplicationsUpdated, undefined);
});

test('navigation during a slow background query is retained when the refreshed rows arrive', async t => {
  let apps = Array.from({ length: 12 }, (_, i) => app(`App ${i}`)), hold = false, resolveQuery;
  const normal = appSearch(() => apps);
  const { w, scope, input, key, events } = await setup(t, { search: (id, args, fixtures) => {
    if (hold && id === 'app' && args.query === 'App') {
      hold = false;
      return new Promise(resolve => { resolveQuery = () => resolve(normal(id, args, fixtures)); });
    }
    return normal(id, args, fixtures);
  } });
  await scope('app'); await input('App');
  hold = true; apps = [app('App Added'), ...apps]; events.onApplicationsUpdated();
  await wait(() => Boolean(resolveQuery));
  key('ArrowDown');
  await wait(() => w.document.querySelector('.result.active h3')?.textContent === 'App 1');
  resolveQuery();
  await wait(() => w.document.getElementById('results').textContent.includes('App Added'));
  assert.equal(w.document.querySelector('.result.active h3')?.textContent, 'App 1');
});

test('a failed background query keeps the current matching rows visible', async t => {
  let fail = false;
  const normal = appSearch(() => [app('Original')]);
  const { w, q, scope, input, events } = await setup(t, { search: (id, args, fixtures) => {
    if (fail && id === 'app' && args.query) return Promise.reject(new Error('query unavailable'));
    return normal(id, args, fixtures);
  } });
  await scope('app'); await input('Original');
  fail = true; events.onApplicationsUpdated(); await delay(40);
  assert.match(w.document.getElementById('results').textContent, /Original/);
  assert.equal(q.value, 'Original');
});

test('an index update reconciles previously loaded pages within the native response limit', async t => {
  let apps = Array.from({ length: 150 }, (_, i) => app(`App ${i}`));
  const normal = appSearch(() => apps);
  const { w, scope, calls, events } = await setup(t, { native: true, search: (id, args, fixtures) => {
    if (id === 'app') assert.ok(args.limit <= 100, 'respect native page cap');
    return normal(id, args, fixtures);
  } });
  await scope('app');
  const results = w.document.getElementById('results');
  const count = () => w.FlowHubSearchDiagnostics.inspect().queriesCurrent.find(item => item.source === 'app').count;
  for (let offset = 12; offset < 120; offset += 12) {
    results.dispatchEvent(new w.Event('scroll'));
    await wait(() => calls.some(call => call[0] === 'search' && call[1] === 'app' && call[2].offset === offset));
    await wait(() => count() === offset + 12);
  }
  const before = calls.length;
  apps = [app('Added'), ...apps]; events.onApplicationsUpdated();
  await wait(() => calls.slice(before).some(call => call[0] === 'search' && call[1] === 'app' && call[2].offset === 100));
  await delay(30);
  assert.match(results.textContent, /Added/);
  assert.equal(count(), 120);
});
