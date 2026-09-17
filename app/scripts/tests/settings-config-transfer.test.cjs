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
const itemIds = (state) => plain(state.config.plugins.web.settings.items).map((node) => node.id).join(',');

(async () => {
  {
    // 导出范围来自当前配置：全部、core，加上按键名排序的插件。
    const h = harness();
    h.ctx.renderConfigTransfer();
    const html = h.element('#configTransferScope').innerHTML;
    assert.match(html, /value="all"/);
    assert.match(html, /value="core"/);
    assert.ok(html.indexOf('value="clipboard"') < html.indexOf('value="memo"'), '插件按名称排序');
    assert.ok(html.indexOf('value="memo"') < html.indexOf('value="web"'));
  }

  {
    // 预览阶段只展示差异，不落地；版本不同要给出提示。
    const incoming = { core: { hotkey: 'Ctrl+Space' }, plugins: { clipboard: { settings: { retentionDays: 7 } } } };
    const h = harness({
      pickConfigImport: async () => ({ ok: true, path: '/tmp/flowhub-config.json', scope: 'all', exportedAt: 1758096000000, appVersion: '0.1.10', currentAppVersion: '0.1.11', inferred: false, config: incoming })
    });
    await h.ctx.importConfig();
    assert.ok(h.state.configImport, '应暂存待导入内容');
    assert.equal(h.state.config.core.hotkey, 'Alt+Space', '预览阶段不改配置');
    assert.equal(h.state.config.plugins.clipboard.settings.retentionDays, 30);
    assert.equal(h.state.dirty, false, '预览阶段不产生未保存修改');
    const preview = h.element('#configImportPreview');
    assert.equal(preview.hidden, false);
    assert.match(preview.innerHTML, /data-action="apply-config-import" data-import-mode="replace"/);
    assert.match(preview.innerHTML, /data-import-mode="merge"/);
    assert.match(preview.innerHTML, /data-action="cancel-config-import"/);
    assert.match(preview.innerHTML, /core\.hotkey/, '列出变化的字段路径');
    assert.match(preview.innerHTML, /0\.1\.10/, '提示导出文件的应用版本');
    assert.match(h.element('#configTransferStatus').textContent, /比较差异/);
  }

  {
    // 替换：整个范围以导入内容为准，网页目录与 catalogStorage 必须保留。
    const incoming = {
      core: { hotkey: 'Ctrl+Space' },
      plugins: {
        web: { enabled: false, settings: { items: [], catalogStorage: 'sqlite' } },
        clipboard: { enabled: false, settings: { retentionDays: 7 } }
      }
    };
    const h = harness({ pickConfigImport: async () => ({ ok: true, scope: 'all', inferred: false, config: incoming }) });
    await h.ctx.importConfig();
    h.ctx.applyConfigImport('replace');
    assert.equal(h.state.config.core.hotkey, 'Ctrl+Space');
    assert.equal(h.state.config.plugins.clipboard.settings.retentionDays, 7);
    assert.equal(h.state.config.plugins.clipboard.enabled, false);
    assert.equal(h.state.config.plugins.web.enabled, false, '其余字段按导入内容生效');
    assert.equal(itemIds(h.state), 'keep-me', '替换导入不能清空本地网页目录');
    assert.equal(h.state.config.plugins.web.settings.catalogStorage, 'sqlite');
    assert.equal(h.state.configImport, null, '应用后清空待导入内容');
    assert.equal(h.state.dirty, true);
    assert.match(h.element('#configTransferStatus').textContent, /已按「替换」应用/);
  }

  {
    // 合并：导入里没有的键保持当前值。
    const incoming = { plugins: { clipboard: { settings: { retentionDays: 3 } } } };
    const h = harness({ pickConfigImport: async () => ({ ok: true, scope: 'clipboard', inferred: false, config: incoming }) });
    await h.ctx.importConfig();
    h.ctx.applyConfigImport('merge');
    assert.equal(h.state.config.plugins.clipboard.settings.retentionDays, 3, '导入的键生效');
    assert.equal(h.state.config.plugins.clipboard.enabled, true, '未出现在导入文件里的键保持当前值');
    assert.equal(h.state.config.core.hotkey, 'Alt+Space', '模块导入不改动 core');
    assert.equal(plain(h.state.config.plugins.memo.settings.items).length, 1, '模块导入不改动其他插件');
    assert.match(h.element('#configTransferStatus').textContent, /已按「合并」应用「插件 clipboard」/);
  }

  {
    // core 范围、取消导入、以及普通配置文件（推断 scope=all）。
    const core = harness({ pickConfigImport: async () => ({ ok: true, scope: 'core', inferred: true, config: { core: { hotkey: 'F1' } } }) });
    await core.ctx.importConfig();
    assert.match(core.element('#configImportPreview').innerHTML, /按普通配置文件解析/);
    core.ctx.applyConfigImport('merge');
    assert.equal(core.state.config.core.hotkey, 'F1');
    assert.equal(core.state.config.plugins.clipboard.settings.retentionDays, 30, 'core 导入不动插件配置');

    const canceled = harness({ pickConfigImport: async () => ({ ok: true, scope: 'all', config: { core: { hotkey: 'F1' } } }) });
    await canceled.ctx.importConfig();
    canceled.ctx.cancelConfigImport();
    assert.equal(canceled.state.configImport, null);
    assert.equal(canceled.state.config.core.hotkey, 'Alt+Space', '取消不改配置');
    assert.equal(canceled.element('#configImportPreview').hidden, true);
    assert.equal(canceled.element('#configTransferStatus').textContent, '已取消导入，配置未改动。');

    const picked = harness({ pickConfigImport: async () => ({ ok: false, canceled: true }) });
    await picked.ctx.importConfig();
    assert.equal(picked.element('#configTransferStatus').textContent, '已取消导入。');
    assert.equal(picked.state.dirty, false);
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

  console.log('PASS: config export scopes, staged import preview with replace/merge diff, and web-catalog preservation');
})().catch(error => { console.error(error); process.exitCode = 1; });
