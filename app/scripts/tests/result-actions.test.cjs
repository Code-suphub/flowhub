const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../ui/search/search.js'), 'utf8');
const renderSlice = source.slice(source.indexOf('function runResultAction('), source.indexOf('const resultWindow = new window.FlowHubResultWindow();'));
const focusSlice = source.slice(source.indexOf('function focusResultAction('), source.indexOf('function choose('));

function harness() {
  const copied = [];
  const status = [];
  const opened = [];
  const focused = [];
  const actions = [];
  let returned = 0;
  const element = (id) => {
    if (!actions.includes(id)) actions.push(id);
    return element.store[id];
  };
  element.store = {
    keyboardHint: { innerHTML: '' }
  };
  const buttons = [
    { disabled: false, focus() { focused.push('first'); } },
    { disabled: false, focus() { focused.push('second'); } },
    { disabled: true, focus() { focused.push('disabled'); } }
  ];
  const resultsEl = {
    contains: () => false,
    querySelectorAll: () => buttons,
    querySelector: () => null
  };
  const ctx = vm.createContext({
    console, URL, JSON, Number, String, Object, Array, Set, Map, Date, Boolean, Math, Promise,
    state: { index: 0, scope: 'all', clipboardResults: [], expandedClipboard: new Set(), editingClipboard: null },
    window: { FlowHubTools: { render: () => null }, weborg: {} },
    document: {
      getElementById: element,
      documentElement: { dataset: {} },
      activeElement: null
    },
    resultsEl,
    esc: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    formatTime: () => '刚刚',
    formatBytes: (value) => `${value} B`,
    iconHtml: () => '<span class="icon"></span>',
    pathText: () => '目录',
    noteOf: () => '',
    memoPathHtml: () => '<span>分类</span>',
    normalizeUrl: (value) => value || '',
    usageSectionHeading: () => '',
    renderUsageSection: () => '',
    portableQueryCommand: (item) => (item.type === 'dns' ? `dig '${item.hostname}'` : null),
    toolEnabled: () => true,
    resultWindow: { heights: new Map() },
    resultKey: (item) => `${item.type}:${item.id}`,
    lastResultsHtml: '',
    getComputedStyle: () => ({ marginTop: '0', marginBottom: '0' }),
    copyText: (text) => { copied.push(text); return Promise.resolve(); },
    choose: (item) => { opened.push(item); },
    showActionStatus: (message) => status.push(message),
    returnToSearch: () => { returned += 1; },
    render: () => {},
    element
  });
  vm.runInContext(renderSlice, ctx);
  vm.runInContext(focusSlice, ctx);
  return { ctx, copied, status, opened, focused, buttons, resultsEl, hint: () => element.store.keyboardHint.innerHTML, returned: () => returned };
}

const webItem = () => ({ type: 'web', id: 'w1', title: '示例', url: 'https://example.com/', path: '目录 / 示例' });

(async () => {
  {
    // 按钮动作与快捷键走同一条路径。
    const h = harness();
    await h.ctx.runResultAction('open', webItem());
    assert.equal(h.opened.length, 1);
    await h.ctx.runResultAction('copy', webItem());
    assert.equal(h.copied.at(-1), 'https://example.com/');
    assert.equal(h.status.at(-1), '链接已复制');
    await h.ctx.runResultAction('copy', { type: 'app', path: '/Applications/App.app' });
    assert.equal(h.copied.at(-1), '/Applications/App.app');
    assert.equal(h.status.at(-1), '路径已复制');
    await h.ctx.runResultAction('copy', { type: 'memo', content: 'ls -la' });
    assert.equal(h.copied.at(-1), 'ls -la');
    await h.ctx.runResultAction('copy', { type: 'calculation', result: '4' });
    assert.equal(h.copied.at(-1), '4');
    await h.ctx.runResultAction('copy-query', { type: 'dns', hostname: 'example.com' });
    assert.equal(h.copied.at(-1), "dig 'example.com'");
    assert.equal(h.status.at(-1), '查询命令已复制');
    await h.ctx.runResultAction('copy-query', { type: 'web' });
    assert.equal(h.status.at(-1), '这条结果没有可复制的命令');
    await h.ctx.runResultAction('copy', { type: 'web', url: '' });
    assert.equal(h.status.at(-1), '没有可复制的内容');
    await h.ctx.runResultAction('copy', { type: 'twofa', id: 't1' });
    assert.equal(h.opened.at(-1).type, 'twofa', '验证码复制走插件路径');
  }

  {
    // F6 焦点顺序：进入第一个按钮、逐个前进、走完回到搜索框；⇧F6 反向。
    const h = harness();
    h.ctx.document.activeElement = null;
    h.ctx.focusResultAction(1);
    assert.equal(h.focused.join(','), 'first');
    h.ctx.document.activeElement = h.buttons[0];
    h.ctx.focusResultAction(1);
    assert.equal(h.focused.join(','), 'first,second');
    h.ctx.document.activeElement = h.buttons[1];
    h.ctx.focusResultAction(1);
    assert.equal(h.returned(), 1, '走过最后一个按钮回到搜索框');
    h.ctx.document.activeElement = null;
    h.ctx.focusResultAction(-1);
    assert.equal(h.focused.at(-1), 'second', '⇧F6 从最后一个可用按钮进入');

    h.resultsEl.querySelectorAll = () => [];
    h.ctx.focusResultAction(1);
    assert.equal(h.returned(), 2, '当前结果没有操作按钮时回到搜索框');
  }

  console.log('PASS: result actions and F6/Tab/Escape follow one focus order');
})().catch(error => { console.error(error); process.exitCode = 1; });
