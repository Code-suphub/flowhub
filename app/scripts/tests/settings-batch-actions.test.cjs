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
        getClipboardStorageInfo: async () => ({}), getConfigPathInfo: async () => ({ activePath: 'A' })
      }
    }
  });
  vm.runInContext(source.slice(0, bootstrapAt), ctx);
  vm.runInContext('render = () => {}; renderUpdateNotice = () => {}; bindIconFallbacks = () => {};', ctx);
  return { ctx, element, state: vm.runInContext('state', ctx) };
}

const ids = (state, list) => JSON.parse(JSON.stringify(list ?? state.config.plugins.web.settings.items)).map((node) => node.id).join(',');
const childIds = (state, id) => {
  const node = state.config.plugins.web.settings.items.find((item) => item.id === id);
  return JSON.parse(JSON.stringify(node?.children || [])).map((child) => child.id).join(',');
};

function setup(ctx, selected) {
  vm.runInContext(`
    state.mode = "structure";
    state.module = "web";
    state.config = { core: {}, plugins: { web: { settings: { items: [
      { id: "a", title: "A", children: [ { id: "a1", title: "A1" }, { id: "a2", title: "A2" } ] },
      { id: "b", title: "B" },
      { id: "c", title: "C", children: [ { id: "c1", title: "C1" } ] },
      { id: "d", title: "D" },
      { id: "p", title: "P", url: "https://example.test/" }
    ] } } } };
    state.savedConfig = JSON.parse(JSON.stringify(state.config));
    state.selectedId = ${JSON.stringify(selected[0])};
    state.selectedIds = new Set(${JSON.stringify(selected)});
    state.pendingAddId = "";
    state.undo = null;
  `, ctx);
}

(async () => {
  {
    // 祖先也在选中集合里时，只按最外层处理，避免重复删除。
    const h = harness();
    setup(h.ctx, ['a', 'a1', 'b']);
    const targets = h.ctx.batchSelection();
    assert.equal(targets.map((entry) => entry.node.id).join(','), 'a,b', '后代不再单独列出');
  }

  {
    // 批量删除：一次操作、一条撤销，撤销后整棵目录与选中项都回来。
    const h = harness();
    setup(h.ctx, ['a', 'b']);
    h.ctx.deleteSelected();
    assert.equal(ids(h.state), 'c,d,p');
    assert.match(h.state.undo.label, /已删除 2 个节点/);
    assert.equal(h.state.selectedId, 'c', '删除后选中后续节点');

    h.ctx.undoDeletion();
    assert.equal(ids(h.state), 'a,b,c,d,p', '撤销恢复全部节点与顺序');
    assert.equal(childIds(h.state, 'a'), 'a1,a2', '子节点随分支一起恢复');
    assert.equal(h.state.selectedId, 'a', '撤销后选中第一个被恢复的节点');
    assert.equal(h.state.undo, null);
  }

  {
    // 批量移动：本次选择一起移动到目标目录，撤销回到原位置。
    const h = harness();
    setup(h.ctx, ['b', 'd']);
    h.ctx.moveSelectedToTarget('c');
    assert.equal(ids(h.state), 'a,c,p', '被移动的节点离开原层');
    assert.equal(childIds(h.state, 'c'), 'c1,b,d', '按选择顺序追加到目标目录');
    assert.match(h.state.undo.label, /已移动 2 个节点/);

    h.ctx.undoDeletion();
    assert.equal(ids(h.state), 'a,b,c,d,p');
    assert.equal(childIds(h.state, 'c'), 'c1', '撤销恢复目标目录原来的子节点');
  }

  {
    // 移动到自身或自己的子目录必须被拒绝，且不产生撤销入口。
    const h = harness();
    setup(h.ctx, ['c']);
    h.ctx.moveSelectedToTarget('c1');
    assert.equal(ids(h.state), 'a,b,c,d,p', '配置未被改动');
    assert.equal(h.state.undo, null, '被拒绝的移动不应产生撤销');
  }

  {
    // 工具栏：选中数量、删除按钮文案、目标目录选项都要跟着选择变化。
    const h = harness();
    setup(h.ctx, ['a', 'b']);
    h.ctx.renderBatchActions();
    assert.equal(h.element('#batchSelectionCount').textContent, '已选 2 项');
    assert.equal(h.element('#deleteBtn').textContent, '删除 2 项');
    const options = h.element('#batchMoveTarget').innerHTML;
    assert.match(options, /value="c"/, '可选目标包含目录 c');
    assert.match(options, /value=""/, '可选目标包含顶层');
    assert.doesNotMatch(options, /value="a"/, '被选中的分支不能作为目标');
    assert.match(options, /value="c1"/, '无 url 的子节点仍可作为目标');
    assert.match(options, /value="d"/, '无 url 的同级节点仍可作为目标');
    assert.doesNotMatch(options, /value="p"/, '没有子节点的页面不列为目标');

    setup(h.ctx, ['b']);
    h.ctx.renderBatchActions();
    assert.equal(h.element('#batchSelectionCount').textContent, '未多选');
    assert.equal(h.element('#deleteBtn').textContent, '删除节点');
  }

  console.log('PASS: multi-select batch delete and batch move share one undo entry and keep the tree consistent');
})().catch(error => { console.error(error); process.exitCode = 1; });
