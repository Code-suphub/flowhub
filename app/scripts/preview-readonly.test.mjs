import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, request as httpRequest } from 'node:http';
import initSqlJs from 'sql.js';
import vm from 'node:vm';

// Import the actual Vite plugin from an isolated project, with all user paths
// confined to a temporary HOME. No production config or database is accessed.
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(join(tmpdir(), 'flowhub-preview-'));
const originalHome = process.env.HOME;
after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(fixture, { recursive: true, force: true });
});
process.env.HOME = join(fixture, 'home');
const fixtureApp = join(fixture, 'app');
const support = join(process.env.HOME, 'Library', 'Application Support', 'FlowHub');
const storage = join(support, 'clipboard');
await mkdir(storage, { recursive: true });
await mkdir(fixtureApp);
await symlink(join(app, 'node_modules'), join(fixtureApp, 'node_modules'), 'dir');
await copyFile(join(app, 'vite.config.mjs'), join(fixtureApp, 'vite.config.mjs'));
const configPath = join(support, 'custom-config.json');
const locatorPath = join(support, 'config-location.json');
const databasePath = join(storage, 'weborg.db');
const items = [{ id: 'folder', title: 'Folder', children: [{ id: 'page', title: 'Page', url: 'https://example.com' }] }];
const config = { core: { configPath, theme: 'dark' }, plugins: {
  web: { settings: { items: [] } }, clipboard: { settings: { storagePath: storage } }
} };
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
await writeFile(locatorPath, JSON.stringify({ configPath }));
await writeFile(join(fixture, 'config.json'), '{"core":{"fallback":true}}\n');
const SQL = await initSqlJs();
const db = new SQL.Database();
db.run('CREATE TABLE web_catalog_nodes (id TEXT, parent_id TEXT, sort_order INTEGER, data_json TEXT)');
db.run('INSERT INTO web_catalog_nodes VALUES (?, NULL, 0, ?)', ['folder', JSON.stringify({ title: 'Folder' })]);
db.run('INSERT INTO web_catalog_nodes VALUES (?, ?, 0, ?)', ['page', 'folder', JSON.stringify(items[0].children[0])]);
await writeFile(databasePath, db.export());
db.close();
const { default: viteConfig } = await import(pathToFileURL(join(fixtureApp, 'vite.config.mjs')));
const routes = new Map();
for (const plugin of viteConfig.plugins) plugin.configureServer({ middlewares: { use: (path, handler) => routes.set(path, handler) } });
const handler = routes.get('/__weborg/config');
async function snapshot(directory = fixture) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) entries.push([path, 'directory'], ...await snapshot(path));
    else entries.push([path, (await readFile(path)).toString('base64')]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}
const before = await snapshot();
async function invoke(callback, method, url = '/', body = '') {
  let bodyReads = 0;
  const request = { method, url, headers: { 'content-length': String(body.length) },
    [Symbol.asyncIterator]() { bodyReads++; throw new Error('Rejected methods must not read the body'); }
  };
  const headers = {};
  const response = { setHeader(name, value) { headers[name.toLowerCase()] = value; }, end(value) { this.body = value; } };
  await callback(request, response);
  assert.equal(bodyReads, 0);
  return { ...response, headers };
}

test('all preview middleware reject write methods without consuming a valid or oversized body', async () => {
  const validBody = JSON.stringify({ ...config, core: { ...config.core, theme: 'light' } });
  for (const [route, callback] of routes) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const body of [validBody, 'x'.repeat(2 * 1024 * 1024)]) {
        const response = await invoke(callback, method, '/', body);
        assert.equal(response.statusCode, 405, `${method} ${route}`);
        assert.equal(response.headers.allow, 'GET');
      }
    }
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const response = await invoke(handler, method, '/location', validBody);
    assert.equal(response.statusCode, 405);
    assert.equal(JSON.parse(response.body).readonly, true);
  }
  assert.deepEqual(await snapshot(), before, 'file bytes and paths must not change');
});

test('GET config hydrates SQLite catalog and location preserves the active path', async () => {
  const response = await invoke(handler, 'GET');
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.core.theme, 'dark');
  assert.deepEqual(result.plugins.web.settings.items, items);
  assert.equal(result.plugins.web.settings.catalogStorage, 'sqlite');
  assert.equal(result.plugins.web.settings.catalogCount, 2);
  assert.match(result.plugins.web.settings.catalogSignature, /^[a-f0-9]{64}$/);
  const location = JSON.parse((await invoke(handler, 'GET', '/location')).body);
  assert.equal(location.activePath, configPath);
  assert.equal(location.configuredPath, configPath);
  assert.equal(location.readonly, true);
  assert.deepEqual(await snapshot(), before);
});

test('HTTP rejection arrives before an unfinished large request body', async () => {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const validBody = { ...config, core: { ...config.core, theme: 'light' },
        plugins: { ...config.plugins, web: { settings: { items } } } };
      const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
        method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
        signal: AbortSignal.timeout(2000)
      });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
      assert.equal((await response.json()).readonly, true);
      assert.deepEqual(await snapshot(), before);
      await new Promise((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port: server.address().port, method,
          path: '/', headers: { 'content-length': 1024 ** 3, 'content-type': 'application/json' }
        }, response => {
          assert.equal(response.statusCode, 405);
          assert.equal(response.headers.allow, 'GET');
          response.resume();
          response.on('end', () => { request.destroy(); resolve(); });
        });
        request.on('error', reject);
        request.setTimeout(2000, () => { request.destroy(); reject(new Error('Waited for request body')); });
        request.flushHeaders(); // Deliberately never send or end the body.
      });
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  assert.deepEqual(await snapshot(), before);
});


test('preview adapters refuse settings and both clipboard copy implementations', async () => {
  const adapterSource = await readFile(join(app, 'ui/browser-adapter.js'), 'utf8');
  const context = vm.createContext({
    window: {}, location: { pathname: '/search.html' },
    document: { documentElement: { dataset: {} }, getElementById: () => null },
    fetch() { throw new Error('saveConfig must not send requests'); }
  });
  vm.runInContext(adapterSource, context);
  const result = await context.window.weborg.saveConfig(config);
  assert.equal(result.ok, false);
  assert.equal(result.readonly, true);
  const searchSource = await readFile(join(app, 'ui/search.js'), 'utf8');
  const copySource = searchSource.slice(searchSource.indexOf('async function copyText('), searchSource.indexOf('function showActionStatus('));
  let writes = 0;
  for (const modern of [true, false]) {
    const document = { documentElement: { dataset: { weborgReadonly: 'true' } },
      createElement: () => ({ style: {}, select() {}, remove() {} }),
      body: { appendChild() {} }, execCommand: () => { writes++; return true; } };
    const copyContext = vm.createContext({ document,
      navigator: modern ? { clipboard: { writeText: async () => { writes++; } } } : {} });
    vm.runInContext(copySource, copyContext);
    await assert.rejects(copyContext.copyText('preview'), /浏览器预览不能修改剪贴板/);
    assert.equal(writes, modern ? 0 : 1);
    document.documentElement.dataset.weborgReadonly = 'false';
    await copyContext.copyText('native');
  }
  assert.equal(writes, 2, 'native runtime retains both copy implementations');
});
