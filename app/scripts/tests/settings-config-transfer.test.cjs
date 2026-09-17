const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../ui/settings/settings.js'), 'utf8');
const bootstrapAt = source.lastIndexOf('\nPromise.all([window.weborg.listPlugins()');

function harness(weborg = {}) {
  const nodes = new Map();
  const element = (selector) => {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, {
        value: '', textContent: '', innerHTML: '', hidden: false, title: '', dataset: {},
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
          toggle: (name, on) => {
            const next = on === undefined ? !classes.has(name) : Boolean(on);
            if (next) classes.add(name); else classes.delete(name);
            return next;
          },
          contains: (name) => classes.has(name)
        },
        setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {}, focus() {},
        querySelector: () => null, querySelectorAll: () => [], closest: () => null, matches: () => false
      });
    }
    return nodes.get(selector);
  };
  const ctx = vm.createContext({
    console, URL, URLSearchParams, Set, Map, Date, JSON, Number, String, Object, Array, Boolean, Promise,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      documentElement: { dataset: {}, style: { setProperty() {} } },
      querySelector: (selector) => (selector === '.settings-actionbar' ? null : element(selector)),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => element('created')
    },
    window: {
      location: { search: '' }, addEventListener() {}, confirm: () => true,
      flowhubPerformance: { measure: (_, fn) => fn() },
      weborg: {
        listPlugins: async () => [], getConfig: async () => ({}),
        getClipboardStorageInfo: async () => ({}), getConfigPathInfo: async () => ({ activePath: 'A' }),
        ...weborg
      }
    }
  });
  vm.runInContext(source.slice(0, bootstrapAt), ctx);
  vm.runInContext('render = () => {}; renderUpdateNotice = () => {};', ctx);
  vm.runInContext(`
    state.config = { core: { hotkey: "Alt+Space" }, plugins: {
      web: { enabled: true, settings: { items: [ { id: "keep-me" } ], catalogStorage: "sqlite" } },
      clipboard: { enabled: true, settings: { retentionDays: 30 } },
      memo: { settings: { items: [ { id: "m1" } ] } }
    } };
    state.savedConfig = JSON.parse(JSON.stringify(state.config));
  `, ctx);
  return { ctx, element, state: vm.runInContext('state', ctx) };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

(async () => {
  {
    // 导出范围来自当前配置：全部、core，加上按键名排序的插件。
    const h = harness();
    h.ctx.renderConfigTransfer();
    const html = h.element('#configTransferScope').innerHTML;
    assert.match(html, /value="all"/);
    assert.match(html, /value="core"/);
    assert.match(html, /value="clipboard"/);
    assert.ok(html.indexOf('value="clipboard"') < html.indexOf('value="memo"'), '插件按名称排序');
    assert.ok(html.indexOf('value="memo"') < html.indexOf('value="web"'));
  }

  {
    // 整体导入：套用导入内容，但网页目录（数据库）不能被清空。
    const incoming = {
      core: { hotkey: 'Ctrl+Space' },
      plugins: {
        web: { enabled: false, settings: { items: [], catalogStorage: 'sqlite' } },
        clipboard: { enabled: false, settings: { retentionDays: 7 } }
      }
    };
    const h = harness({ pickConfigImport: async () => ({ ok: true, scope: 'all', inferred: false, config: incoming }) });
    await h.ctx.importConfig();
    assert.equal(h.state.config.core.hotkey, 'Ctrl+Space');
    assert.equal(h.state.config.plugins.clipboard.settings.retentionDays, 7);
    assert.equal(h.state.config.plugins.clipboard.enabled, false);
    assert.equal(
      plain(h.state.config.plugins.web.settings.items).map((node) => node.id).join(','),
      'keep-me',
      '导入整体配置不能清空本地网页目录'
    );
    assert.equal(h.state.config.plugins.web.settings.catalogStorage, 'sqlite');
    assert.equal(h.state.config.plugins.web.enabled, false, '其余字段按导入内容生效');
    assert.match(h.element('#configTransferStatus').textContent, /已导入「全部配置」/);
    assert.equal(h.state.dirty, true);
  }

  {
    // 模块导入：只替换该模块，其他模块保持不动。
    const incoming = { plugins: { clipboard: { enabled: false, settings: { retentionDays: 3 } } } };
    const h = harness({ pickConfigImport: async () => ({ ok: true, scope: 'clipboard', inferred: false, config: incoming }) });
    await h.ctx.importConfig();
    assert.equal(h.state.config.plugins.clipboard.settings.retentionDays, 3);
    assert.equal(h.state.config.core.hotkey, 'Alt+Space', '模块导入不改动 core');
    assert.equal(plain(h.state.config.plugins.memo.settings.items).length, 1, '模块导入不改动其他插件');
    assert.match(h.element('#configTransferStatus').textContent, /「插件 clipboard」/);
  }

  {
    // core 导入与取消路径。
    const h = harness({ pickConfigImport: async () => ({ ok: true, scope: 'core', inferred: true, config: { core: { hotkey: 'F1' } } }) });
    await h.ctx.importConfig();
    assert.equal(h.state.config.core.hotkey, 'F1');
    assert.equal(h.state.config.plugins.clipboard.settings.retentionDays, 30, 'core 导入不动插件配置');
    assert.match(h.element('#configTransferStatus').textContent, /按普通配置文件解析/);

    const canceled = harness({ pickConfigImport: async () => ({ ok: false, canceled: true }) });
    await canceled.ctx.importConfig();
    assert.equal(canceled.element('#configTransferStatus').textContent, '已取消导入。');
    assert.equal(canceled.state.dirty, false);
  }

  {
    // 导出：使用所选范围，取消与失败都要有反馈。
    const calls = [];
    const h = harness({ exportConfig: async (scope) => { calls.push(scope); return { ok: true, path: '/tmp/flowhub-web.json', bytes: 2048 }; } });
    h.element('#configTransferScope').value = 'web';
    await h.ctx.exportConfig();
    assert.equal(calls.join(','), 'web');
    assert.match(h.element('#configTransferStatus').textContent, /已导出「插件 web」到 \/tmp\/flowhub-web\.json/);

    const canceled = harness({ exportConfig: async () => ({ ok: false, canceled: true }) });
    await canceled.ctx.exportConfig();
    assert.equal(canceled.element('#configTransferStatus').textContent, '已取消导出。');

    const failed = harness({ exportConfig: async () => { throw new Error('浏览器预览不支持导出配置'); } });
    await failed.ctx.exportConfig();
    assert.match(failed.element('#configTransferStatus').textContent, /导出失败：浏览器预览不支持导出配置/);
  }

  console.log('PASS: config export scopes, whole/module/core import and web-catalog preservation');
})().catch(error => { console.error(error); process.exitCode = 1; });
