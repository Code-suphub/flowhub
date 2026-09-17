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
        value: '', textContent: '', innerHTML: '', hidden: false, title: '', disabled: false, dataset: {},
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
  vm.runInContext('render = () => {}; renderUpdateNotice = () => {}; bindIconFallbacks = () => {};', ctx);
  return { ctx, element, state: vm.runInContext('state', ctx) };
}

function setup(ctx) {
  vm.runInContext(`
    state.mode = "structure";
    state.module = "web";
    state.config = { core: {}, plugins: { web: { settings: { items: [
      { id: "a", title: "A", children: [ { id: "a1", title: "A1" } ] },
      { id: "p", title: "P", url: "https://example.test/" },
      { id: "empty", title: "空目录", children: [] }
    ] } } } };
    state.savedConfig = JSON.parse(JSON.stringify(state.config));
    state.selectedId = "";
    state.selectedIds = new Set();
    state.pendingAddId = "";
    state.undo = null;
    state.webImport = null;
  `, ctx);
}

const ids = (state) => JSON.parse(JSON.stringify(state.config.plugins.web.settings.items))
  .map((node) => node.id).join(',');
const plan = (ctx, items, mode) => {
  const result = ctx.planWebImport(items, mode);
  return {
    additions: result.additions.map((entry) => entry.node.id).join(','),
    replacements: result.replacements.map((entry) => entry.target.id).join(','),
    skipped: result.skipped.map((entry) => `${entry.node.id}:${entry.reason}`).join(',')
  };
};

(async () => {
  {
    // “仅导入新增”只放行真正的新节点：ID 重复、网址重复、文件内自身重复都要跳过。
    const h = harness();
    setup(h.ctx);
    const incoming = [
      { id: 'a', title: '重复 ID', children: [{ id: 'a9', title: '不该混进来' }] },
      { id: 'p2', title: '重复网址', url: 'https://example.test/' },
      { id: 'n1', title: '新目录', children: [{ id: 'n1a', title: '新子节点' }] },
      { id: 'n1', title: '文件内重复' },
      { id: 'n2', title: '新页面', url: 'https://n2.test/' }
    ];
    const result = plan(h.ctx, incoming, 'new');
    assert.equal(result.additions, 'n1,n1a,n2', '只新增不冲突的节点');
    assert.equal(result.replacements, '', '“仅导入新增”不做覆盖');
    assert.equal(
      result.skipped,
      'a:ID 已存在,p2:网址已存在,n1:文件内 ID 重复',
      '重复项按原因分类跳过'
    );
  }

  {
    // “覆盖同 ID”替换原位置的字段，子节点按计划挂进已有节点，不整体替换 children。
    const h = harness();
    setup(h.ctx);
    const incoming = [
      { id: 'a', title: '新标题', accent: 'blue', children: [{ id: 'a2', title: 'A2' }] },
      { id: 'a1', title: '改过的 A1' }
    ];
    const result = plan(h.ctx, incoming, 'overwrite');
    assert.equal(result.additions, 'a2', '同 ID 的新子节点算新增');
    assert.equal(result.replacements, 'a,a1', '同 ID 的节点逐个覆盖');
    assert.equal(result.skipped, '', '覆盖模式下没有跳过项');

    h.ctx.applyWebImportPlan(h.ctx.planWebImport(incoming, 'overwrite'));
    const nodes = JSON.parse(JSON.stringify(h.state.config.plugins.web.settings.items));
    const a = nodes.find((node) => node.id === 'a');
    assert.equal(a.title, '新标题', '覆盖写回字段');
    assert.equal(a.accent, 'blue');
    assert.equal(a.children.map((child) => child.id).join(','), 'a1,a2', '保留原有子节点并追加新子节点');
    assert.equal(a.children[0].title, '改过的 A1', '子节点也能被覆盖');
  }

  {
    // 应用导入：目录被改写、只留一条撤销，撤销回到导入前的整棵目录。
    const h = harness();
    setup(h.ctx);
    h.state.webImport = {
      path: '/tmp/web.json',
      bytes: 100,
      items: [{ id: 'n1', title: '新目录', children: [{ id: 'n1a', title: '新子节点' }] }]
    };
    h.ctx.applyWebImport('new');
    assert.equal(ids(h.state), 'a,p,empty,n1', '新增追加到顶层末尾');
    assert.equal(h.state.webImport, null, '应用后清空待导入状态');
    assert.equal(h.state.selectedId, 'n1', '选中第一个新增节点');
    assert.match(h.state.undo.label, /已导入 2 个网页节点/);

    h.ctx.undoDeletion();
    assert.equal(ids(h.state), 'a,p,empty', '撤销回到导入前');
    assert.equal(h.state.undo, null);
  }

  {
    // 全部重复时给出提示且不改动目录，也不产生撤销入口。
    const h = harness();
    setup(h.ctx);
    h.state.webImport = { path: '', bytes: 0, items: [{ id: 'a', title: '重复' }] };
    h.ctx.applyWebImport('new');
    assert.equal(ids(h.state), 'a,p,empty', '配置未被改动');
    assert.equal(h.state.undo, null, '没有可用节点时不记录撤销');
    assert.match(h.element('#toastMessage').textContent, /没有可导入的节点/);
  }

  {
    // 预览卡片：无待导入时隐藏；有待导入时同时给出两种模式的计数与按钮。
    const h = harness();
    setup(h.ctx);
    h.ctx.renderWebImportPreview();
    assert.equal(h.element('#webImportPreview').hidden, true);

    h.state.webImport = {
      path: '/tmp/web.json',
      bytes: 10,
      items: [{ id: 'a', title: '重复' }, { id: 'n1', title: '新页面', url: 'https://n1.test/' }]
    };
    h.ctx.renderWebImportPreview();
    const card = h.element('#webImportPreview');
    assert.equal(card.hidden, false);
    assert.match(card.innerHTML, /待导入网页目录/);
    assert.match(card.innerHTML, /新增 1 · 覆盖 0 · 跳过 1/, '“仅导入新增”的统计');
    assert.match(card.innerHTML, /新增 1 · 覆盖 1 · 跳过 0/, '“覆盖同 ID”的统计');
    assert.match(card.innerHTML, /data-import-mode="new"/);
    assert.match(card.innerHTML, /data-import-mode="overwrite"/);
    assert.match(card.innerHTML, /跳过「重复」：ID 已存在/);

    h.ctx.cancelWebImport();
    assert.equal(h.state.webImport, null);
    assert.equal(card.hidden, true);
  }

  {
    // 选择文件：取消不动状态；成功进入预览；读取报错给出提示并保持干净。
    const h = harness({
      pickWebImport: async () => ({ canceled: true })
    });
    setup(h.ctx);
    await h.ctx.importWebCatalog();
    assert.equal(h.state.webImport, null, '取消后没有待导入内容');

    const ok = harness({
      pickWebImport: async () => ({ ok: true, path: '/tmp/web.json', bytes: 12, items: [{ id: 'n1' }] })
    });
    setup(ok.ctx);
    await ok.ctx.importWebCatalog();
    assert.equal(ok.state.webImport.items.length, 1);
    assert.equal(ok.state.webImport.path, '/tmp/web.json');
    assert.equal(ok.element('#webImportPreview').hidden, false);

    const bad = harness({
      pickWebImport: async () => { throw new Error('不是有效 JSON'); }
    });
    setup(bad.ctx);
    await bad.ctx.importWebCatalog();
    assert.equal(bad.state.webImport, null, '失败后不留待导入状态');
    assert.match(bad.element('#toastMessage').textContent, /导入失败：不是有效 JSON/);
  }

  {
    // 空 items 也要被当成失败，避免把“导入了 0 项”当成成功。
    const h = harness({ pickWebImport: async () => ({ ok: true, items: [] }) });
    setup(h.ctx);
    await h.ctx.importWebCatalog();
    assert.equal(h.state.webImport, null);
    assert.match(h.element('#toastMessage').textContent, /没有网页节点/);
  }

  console.log('PASS: web catalog import plans dedup by id and url, previews conflicts, and undoes in one step');
})().catch(error => { console.error(error); process.exitCode = 1; });
