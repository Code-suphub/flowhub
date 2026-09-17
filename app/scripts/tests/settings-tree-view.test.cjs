const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../ui/settings/settings.js'), 'utf8');
const bootstrapAt = source.lastIndexOf('\nPromise.all([window.weborg.listPlugins()');

const ROW_HEIGHT = 30;

// 目录侧栏用真实一点的最小 DOM：innerHTML 赋值后按 data-node-id 顺序生成行，
// 行高固定，滚动容器只保留 scrollTop/clientHeight。行对象按 innerHTML 缓存，
// 这样一次渲染内的 querySelectorAll 返回同一批对象，焦点比较才有意义。
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

  const documentRef = {
    documentElement: { dataset: {}, style: { setProperty() {} } },
    activeElement: null,
    querySelector: (selector) => {
      if (selector === '.settings-actionbar') return null;
      if (selector === '.sidebar') return container;
      if (selector === '#tree') return tree;
      return element(selector);
    },
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => element('created')
  };

  const container = { scrollTop: 0, clientHeight: 3 * ROW_HEIGHT, querySelectorAll: () => [] };
  const tree = { rows: [] };
  Object.defineProperty(tree, 'innerHTML', {
    get() { return this.html || ''; },
    set(html) {
      this.html = String(html);
      this.rows = [...this.html.matchAll(/data-node-id="([^"]*)"/g)].map((match, index) => ({
        dataset: { nodeId: match[1] },
        offsetTop: index * ROW_HEIGHT,
        offsetHeight: ROW_HEIGHT,
        focused: false,
        focus() { this.focused = true; documentRef.activeElement = this; },
        querySelectorAll: () => [],
        getAttribute: () => null
      }));
    }
  });
  tree.querySelectorAll = (selector) => (selector === '.tree-row' ? tree.rows : []);

  const ctx = vm.createContext({
    console, URL, URLSearchParams, Set, Map, Date, JSON, Number, String, Object, Array, Boolean, Promise, Math,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: documentRef,
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
  return { ctx, element, document: documentRef, container, tree, state: vm.runInContext('state', ctx) };
}

function setup(ctx, count) {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    items.push({ id: `n${index}`, title: `节点 ${index}` });
  }
  vm.runInContext(`
    state.mode = "structure";
    state.module = "web";
    state.config = { core: {}, plugins: { web: { settings: { items: ${JSON.stringify(items)} } } } };
    state.savedConfig = JSON.parse(JSON.stringify(state.config));
    state.selectedId = "n0";
    state.selectedIds = new Set(["n0"]);
    state.expanded = new Set();
    state.treeFilter = "";
    state.lastRenderedSelectionId = "";
    state.lastRenderedTreeFilter = "";
  `, ctx);
}

const renderedIds = (tree) => tree.rows.map((row) => row.dataset.nodeId).join(',');

(async () => {
  {
    // 展开上方节点后视口里那一行保持原位：行号会变，但滚动偏移要跟着锚点走。
    const h = harness();
    setup(h.ctx, 12);
    h.ctx.renderTree();
    assert.equal(h.container.scrollTop, 0, '首次渲染停在顶部');

    h.container.scrollTop = 5 * ROW_HEIGHT;
    h.ctx.renderTree();
    assert.equal(h.container.scrollTop, 5 * ROW_HEIGHT, '内容不变时保持滚动位置');

    h.state.expanded.add('n0');
    h.state.config.plugins.web.settings.items[0].children = [0, 1, 2, 3, 4]
      .map((index) => ({ id: `n0c${index}`, title: `子节点 ${index}` }));
    h.ctx.renderTree();
    assert.equal(
      h.tree.rows.find((row) => row.dataset.nodeId === 'n5').offsetTop,
      10 * ROW_HEIGHT,
      'n5 被上面的展开推到第 11 行'
    );
    assert.equal(h.container.scrollTop, 10 * ROW_HEIGHT, '视口跟着锚点移动，n5 仍在顶部');
  }

  {
    // 筛选变化时旧偏移没有意义，回到顶部；清空筛选同样从头看。
    const h = harness();
    setup(h.ctx, 12);
    h.ctx.renderTree();
    h.container.scrollTop = 6 * ROW_HEIGHT;

    h.state.treeFilter = 'n11';
    h.ctx.renderTree();
    assert.equal(h.container.scrollTop, 0, '进入筛选回到顶部');
    assert.equal(renderedIds(h.tree), 'n11', '筛选后只渲染匹配行');

    h.state.treeFilter = '';
    h.ctx.renderTree();
    assert.equal(h.container.scrollTop, 0, '清空筛选也回到顶部');
    assert.equal(renderedIds(h.tree).split(',').length, 12);
  }

  {
    // 锚点行被删掉时退回原来的偏移；目录清空时归零，不留下越界位置。
    const h = harness();
    setup(h.ctx, 12);
    h.ctx.renderTree();
    h.container.scrollTop = 5 * ROW_HEIGHT;

    h.state.config.plugins.web.settings.items = h.state.config.plugins.web.settings.items
      .filter((node) => node.id !== 'n5');
    h.ctx.renderTree();
    assert.equal(h.container.scrollTop, 5 * ROW_HEIGHT, '锚点消失后保持原偏移');

    h.state.config.plugins.web.settings.items = [];
    h.ctx.renderTree();
    assert.equal(h.container.scrollTop, 0, '目录为空时滚动归零');
    assert.match(h.tree.innerHTML, /tree-empty/);
  }

  {
    // 行内焦点按节点 ID 还原，键盘用户在重绘后可以继续操作同一行。
    const h = harness();
    setup(h.ctx, 12);
    h.ctx.renderTree();
    h.container.scrollTop = 5 * ROW_HEIGHT;
    h.document.activeElement = h.tree.rows[7];

    h.state.expanded.add('n0');
    h.state.config.plugins.web.settings.items[0].children = [{ id: 'n0c0', title: '子节点' }];
    h.ctx.renderTree();
    const focused = h.tree.rows.find((row) => row.dataset.nodeId === 'n7');
    assert.equal(focused.focused, true, '焦点回到同一节点的新行');
    assert.equal(h.document.activeElement.dataset.nodeId, 'n7');
  }

  {
    // 选择被其它动作改到视口外时带进视口；选择没变时用户自己的滚动不被拉回。
    const h = harness();
    setup(h.ctx, 12);
    h.ctx.renderTree();
    assert.equal(h.container.scrollTop, 0);

    h.state.selectedId = 'n9';
    h.ctx.renderTree();
    assert.equal(h.container.scrollTop, 9 * ROW_HEIGHT + ROW_HEIGHT - 3 * ROW_HEIGHT, '选中行滚入视口底部对齐');
    assert.equal(h.state.lastRenderedSelectionId, 'n9');

    h.container.scrollTop = 0;
    h.ctx.renderTree();
    assert.equal(h.container.scrollTop, 0, '选择未变化时不把用户拉回选中行');
  }

  console.log('PASS: settings tree keeps scroll anchor, focus and selection across long-catalog re-renders');
})().catch(error => { console.error(error); process.exitCode = 1; });
