const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../ui/settings/settings.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(__dirname, '../../ui/shared/command-store.js'), 'utf8');
const bootstrapAt = source.lastIndexOf('\nPromise.all([window.weborg.listPlugins()');

function harness({ withStore = true } = {}) {
  const nodes = new Map();
  const element = (selector) => {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, {
        value: '', textContent: '', innerHTML: '', hidden: false, title: '', disabled: false, checked: false, dataset: {}, style: {},
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
  const listeners = {};
  const data = new Map();
  const windowRef = {
    location: { search: '' }, addEventListener() {}, confirm: () => true,
    localStorage: {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: (key) => data.delete(key)
    },
    flowhubPerformance: { measure: (_, fn) => fn(), enable() {}, reset() {}, report: () => '' },
    weborg: {
      listPlugins: async () => [], getConfig: async () => ({}),
      getClipboardStorageInfo: async () => ({}), getConfigPathInfo: async () => ({ activePath: 'A' })
    }
  };
  const ctx = vm.createContext({
    console, URL, URLSearchParams, Set, Map, Date, JSON, Number, String, Object, Array, Boolean, Promise, Math,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: windowRef.localStorage,
    document: {
      documentElement: { dataset: {}, style: { setProperty() {} } },
      querySelector: (selector) => (selector === '.settings-actionbar' ? null : element(selector)),
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
      createElement: () => element('created')
    },
    window: windowRef
  });
  if (withStore) vm.runInContext(storeSource, ctx);
  vm.runInContext(source.slice(0, bootstrapAt), ctx);
  vm.runInContext('render = () => {}; renderUpdateNotice = () => {}; bindIconFallbacks = () => {};', ctx);
  return {
    ctx, element, listeners,
    store: windowRef.FlowHubCommandStore,
    state: vm.runInContext('state', ctx),
    // 工具开关由 input 监听处理（checkbox 同时会触发 change，但设置页只监听 input）。
    fireInput: (target) => { for (const fn of listeners.input || []) fn({ target }); }
  };
}

function config() {
  return {
    core: {},
    plugins: {
      web: { settings: { items: [] } },
      tools: { enabled: true, settings: {} },
      memo: { settings: {} }
    }
  };
}

(async () => {
  {
    // 默认开启记录：老的配置文件没有这个字段时按 true 处理。
    const h = harness();
    h.state.config = h.ctx.normalizeConfig(config());
    assert.equal(h.state.config.plugins.tools.settings.commandHistory, true, '默认记录命令历史');
    h.state.config.plugins.tools.settings.commandHistory = false;
    assert.equal(h.ctx.normalizeConfig(JSON.parse(JSON.stringify(h.state.config))).plugins.tools.settings.commandHistory, false, '显式关闭时保留 false');
  }

  {
    // 汇总：没有记录时给出说明；有记录时按工具统计并带上模板数量。
    const h = harness();
    h.state.config = h.ctx.normalizeConfig(config());
    h.ctx.renderSettingsFields();
    assert.match(h.element('#commandHistorySummary').textContent, /还没有记录/);

    h.store.history.record('ping', 'ping example.com');
    h.store.history.record('ping', 'ping example.org');
    h.store.history.record('curl', 'curl https://example.com');
    h.store.templates.save('port', { query: 'port 9000' });
    h.ctx.renderSettingsFields();
    assert.equal(
      h.element('#commandHistorySummary').textContent,
      '已记录 3 条命令（curl 1 · ping 2） · 1 个参数模板'
    );
  }

  {
    // 开关走设置页真实的 input 处理：写进 plugins.tools.settings 并标脏。
    const h = harness();
    h.state.config = h.ctx.normalizeConfig(config());
    h.state.dirty = false;
    h.fireInput({ dataset: { toolSetting: 'commandHistory' }, checked: false });
    assert.equal(h.state.config.plugins.tools.settings.commandHistory, false);
    assert.equal(h.state.dirty, true, '关闭记录后提示需要保存');
    h.fireInput({ dataset: { toolSetting: 'commandHistory' }, checked: true });
    assert.equal(h.state.config.plugins.tools.settings.commandHistory, true);
  }

  {
    // 清空按钮同时清掉历史与模板，并把汇总刷新回空状态。
    const h = harness();
    h.state.config = h.ctx.normalizeConfig(config());
    h.store.history.record('ping', 'ping example.com');
    h.store.templates.save('ping', { query: 'ping 10.0.0.1' });
    h.ctx.renderSettingsFields();
    assert.match(h.element('#commandHistorySummary').textContent, /已记录 1 条命令/);

    h.ctx.handleAction('clear-command-history');
    assert.equal(JSON.stringify(h.store.counts()), '{"total":0,"templates":0,"byTool":{}}');
    assert.match(h.element('#commandHistorySummary').textContent, /还没有记录/);
    assert.equal(h.element('#toastMessage').textContent, '已清空命令历史与参数模板');
  }

  {
    // 浏览器预览等没有该模块的场景：汇总给出说明，清空按钮不抛异常。
    const h = harness({ withStore: false });
    h.state.config = h.ctx.normalizeConfig(config());
    h.ctx.renderSettingsFields();
    assert.match(h.element('#commandHistorySummary').textContent, /浏览器预览不支持读取命令历史/);
    h.ctx.handleAction('clear-command-history');
  }

  console.log('PASS: settings expose the command-history switch, summary and clear action');
})().catch(error => { console.error(error); process.exitCode = 1; });
