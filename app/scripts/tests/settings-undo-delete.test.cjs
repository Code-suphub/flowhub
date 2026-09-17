const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../ui/settings/settings.js'), 'utf8');
const bootstrapAt = source.lastIndexOf('\nPromise.all([window.weborg.listPlugins()');

function harness() {
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
        querySelector: () => null, querySelectorAll: () => [], closest: () => null, matches: () => false,
        getBoundingClientRect: () => ({ height: 0 })
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
        getClipboardStorageInfo: async () => ({}), getConfigPathInfo: async () => ({ activePath: 'A' })
      }
    }
  });
  vm.runInContext(source.slice(0, bootstrapAt), ctx);
  vm.runInContext('render = () => {}; renderUpdateNotice = () => {};', ctx);
  return { ctx, element, state: vm.runInContext("state", ctx) };
}

function webState(ctx, selected = 'b') {
  vm.runInContext(`
    state.module = "web";
    state.config = { core: {}, plugins: { web: { settings: { items: [
      { id: "a", title: "A" },
      { id: "b", title: "B", children: [ { id: "b1", title: "B1" }, { id: "b2", title: "B2" } ] },
      { id: "c", title: "C" }
    ] } } } };
    state.savedConfig = JSON.parse(JSON.stringify(state.config));
    state.selectedId = ${JSON.stringify(selected)};
    state.undo = null;
  `, ctx);
}

(async () => {
  {
    // 网页目录：删除整个分支后可以撤销，恢复原位置、子节点与选中项。
    const h = harness();
    webState(h.ctx);
    h.ctx.deleteSelected();
    assert.equal(h.ctx.webItems().length, 2, '删除后方只剩两个根节点');
    assert.equal(h.ctx.webItems().some((node) => node.id === 'b'), false);
    assert.ok(h.state.undo, '应记录可撤销的删除');
    assert.equal(h.element('#undoDeleteBtn').classList.contains('hidden'), false, '撤销按钮应可见');

    h.ctx.undoDeletion();
    const items = h.ctx.webItems();
    assert.equal(items.map((node) => node.id).join(','), 'a,b,c', '应恢复回原位置');
    assert.equal(items[1].children.length, 2, '子节点随分支一起恢复');
    assert.equal(h.state.selectedId, 'b', '撤销后选中被恢复的节点');
    assert.equal(h.state.undo, null);
    assert.equal(h.element('#undoDeleteBtn').classList.contains('hidden'), true, '撤销后按钮隐藏');

    // 没有待撤销内容时点击不应报错。
    h.ctx.undoDeletion();
    assert.equal(h.ctx.webItems().length, 3);
  }

  {
    // 备忘：同样支持撤销并恢复选中项。
    const h = harness();
    vm.runInContext(`
      state.module = "memo";
      state.config = { core: {}, plugins: { memo: { settings: { items: [
        { id: "m1", title: "一" }, { id: "m2", title: "二" }, { id: "m3", title: "三" }
      ] } } } };
      state.savedConfig = JSON.parse(JSON.stringify(state.config));
      state.selectedMemoId = "m2";
      state.undo = null;
    `, h.ctx);
    h.ctx.deleteMemo();
    assert.equal(h.ctx.pluginConfig('memo').settings.items.map((item) => item.id).join(','), 'm1,m3');
    assert.equal(h.element('#undoDeleteBtn').classList.contains('hidden'), false);

    h.ctx.undoDeletion();
    assert.equal(h.ctx.pluginConfig('memo').settings.items.map((item) => item.id).join(','), 'm1,m2,m3');
    assert.equal(h.state.selectedMemoId, 'm2');
  }

  {
    // 保存后撤销入口失效，避免撤销指向已经落地的状态。
    const h = harness();
    webState(h.ctx);
    h.ctx.deleteSelected();
    h.ctx.clearUndo();
    assert.equal(h.state.undo, null);
    assert.equal(h.element('#undoDeleteBtn').classList.contains('hidden'), true);
  }

  console.log('PASS: web branch and memo deletion expose a single-level undo that restores position, children and selection');
})().catch(error => { console.error(error); process.exitCode = 1; });
