const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../ui/settings/settings.js'), 'utf8');
const bootstrapAt = source.lastIndexOf('\nPromise.all([window.weborg.listPlugins()');

function harness(weborg = {}) {
  const nodes = new Map();
  const element = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', textContent: '', innerHTML: '', hidden: false, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {}, focus() {},
      querySelector: () => null, querySelectorAll: () => [], closest: () => null, matches: () => false
    });
    return nodes.get(selector);
  };
  const ctx = vm.createContext({
    console, URL, URLSearchParams, Set, Map, Date, JSON, Number, String, Object, Array, Boolean, Promise,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      documentElement: { dataset: {}, style: { setProperty() {} } },
      // 与其它 settings 测试一致：不提供 actionbar，跳过 ResizeObserver 分支。
      querySelector: (selector) => (selector === '.settings-actionbar' ? null : element(selector)),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => element('created')
    },
    window: {
      location: { search: '' }, addEventListener() {}, confirm: () => true,
      flowhubPerformance: { measure: (_, fn) => fn() },
      weborg: {
        listPlugins: async () => [],
        getConfig: async () => ({ core: { hotkey: 'Alt+Space' }, plugins: { web: { settings: { items: [] } } } }),
        getClipboardStorageInfo: async () => ({}),
        getConfigPathInfo: async () => ({ activePath: 'A' }),
        ...weborg
      }
    }
  });
  vm.runInContext(source.slice(0, bootstrapAt), ctx);
  vm.runInContext(`
    normalizeConfig = value => value;
    render = () => {};
    renderUpdateNotice = () => {};
    renderMemoSettings = () => {};
    state.config = { core: { hotkey: 'Alt+Space' }, plugins: { web: { settings: { items: [] } } } };
    state.savedConfig = state.config;
  `, ctx);
  return { ctx, element };
}

(async () => {
  {
    const h = harness({
      listConfigHistory: async () => ({ entries: [
        { id: '1758096000000', created_at: 1758096000000, bytes: 2048, catalog_count: 7 },
        { id: '1758009600000-1', created_at: 1758009600000, bytes: 1024, catalog_count: 3 }
      ], limit: 20 }),
      previewConfigHistory: async () => ({ config: { core: { hotkey: 'Other' }, plugins: { web: { settings: { items: [] } } } } })
    });
    await h.ctx.loadConfigHistory();
    assert.equal(h.element('#configHistoryCount').textContent, '2 / 20 份');
    const html = h.element('#configHistoryList').innerHTML;
    assert.match(html, /data-action="preview-config-history" data-history-id="1758096000000"/);
    assert.match(html, /data-action="restore-config-history" data-history-id="1758009600000-1"/);
    assert.match(html, /2\.0 KB/);
    assert.match(html, /最近/);

    await h.ctx.previewConfigHistory('1758096000000');
    const preview = h.element('#configHistoryPreview');
    assert.equal(preview.hidden, false);
    assert.match(preview.textContent, /顶层字段不同：core/);
    assert.match(preview.textContent, /"hotkey": "Other"/);
  }

  {
    let restored = null;
    const h = harness({
      listConfigHistory: async () => ({ entries: [{ id: '1758096000000', created_at: 1758096000000, bytes: 100, catalog_count: 1 }], limit: 20 }),
      previewConfigHistory: async () => ({ config: {} }),
      restoreConfigHistory: async (id) => {
        restored = id;
        return { restored: id, unchanged: false, requiresRestart: true, warnings: ['备份的剪贴板存储位置与当前不同，重启后才会切换'] };
      }
    });
    await h.ctx.loadConfigHistory();
    await h.ctx.restoreConfigHistory('1758096000000');
    assert.equal(restored, '1758096000000');
    assert.match(h.element('#configHistoryStatus').textContent, /重启/);
    assert.match(h.element('#configHistoryStatus').textContent, /存储位置/);
  }

  {
    let calls = 0;
    const h = harness({
      listConfigHistory: async () => ({ entries: [{ id: '1758096000000', created_at: 1758096000000, bytes: 100, catalog_count: 0 }], limit: 20 }),
      restoreConfigHistory: async (id) => { calls++; return { restored: id, unchanged: true, requiresRestart: false, warnings: [] }; }
    });
    await h.ctx.loadConfigHistory();
    await h.ctx.restoreConfigHistory('1758096000000');
    assert.equal(calls, 1);
    assert.match(h.element('#configHistoryStatus').textContent, /相同/);
  }

  {
    // 浏览器预览：列表为空并给出说明，恢复被适配层拒绝时展示原因而不是抛到界面外。
    const h = harness({
      listConfigHistory: async () => ({ entries: [], limit: 0, directory: '', available: false }),
      previewConfigHistory: async () => { throw new Error('浏览器预览不支持配置历史'); },
      restoreConfigHistory: async () => { throw new Error('浏览器预览不能修改配置'); }
    });
    await h.ctx.loadConfigHistory();
    assert.equal(h.element('#configHistoryCount').textContent, '0 份');
    assert.match(h.element('#configHistoryList').innerHTML, /浏览器预览不提供配置历史/);
    await h.ctx.restoreConfigHistory('1758096000000');
    assert.match(h.element('#configHistoryStatus').textContent, /恢复失败：浏览器预览不能修改配置/);
  }

  {
    // 旧适配层没有历史接口时也不能崩。
    const h = harness();
    await h.ctx.loadConfigHistory();
    assert.equal(h.element('#configHistoryCount').textContent, '0 份');
    assert.match(h.element('#configHistoryList').innerHTML, /浏览器预览不提供配置历史/);
  }

  console.log('PASS: config history list/preview/restore rendering, path warnings and the browser-preview fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
