const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../ui/search/search.js'), 'utf8');
const renderSlice = source.slice(source.indexOf('function resultActions('), source.indexOf('const resultWindow = new window.FlowHubResultWindow();'));
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
    // 每种内置结果都给出统一操作栏，没有可用动作时不渲染空栏。
    const h = harness();
    const web = h.ctx.resultActions(webItem(), 3);
    assert.match(web, /class="result-actions"/);
    assert.match(web, /data-result-action="open" data-result-index="3"/);
    assert.match(web, /data-result-action="copy"[^>]*>复制链接</);

    h.ctx.state.config = { plugins: {} };
    const memo = { type: 'memo', id: 'm1', title: '备忘', content: 'ls -la', description: '' };
    assert.match(h.ctx.resultActions(memo, 0), /复制命令/);
    assert.match(h.ctx.resultActions(memo, 0), />粘贴</);
    assert.doesNotMatch(h.ctx.resultActions({ ...memo, content: '   ' }, 0), /复制命令/, '没有命令时不显示复制');

    const app = { type: 'app', id: 'a1', title: 'App', path: '/Applications/App.app' };
    assert.match(h.ctx.resultActions(app, 0), /复制路径/);
    assert.match(h.ctx.resultActions({ type: 'twofa', id: 't1' }, 0), /复制验证码/);
    assert.match(h.ctx.resultActions({ type: 'calculation', id: 'c1', result: '4' }, 0), /复制结果/);
    assert.match(h.ctx.resultActions({ type: 'jwt', id: 'j1', result: '{}' }, 0), /复制结果/);
    assert.match(h.ctx.resultActions({ type: 'dns', id: 'd1', hostname: 'example.com', family: 'IPv4' }, 0), /复制查询命令/);
    assert.equal(h.ctx.resultActions({ type: 'web-add', id: 'x', url: 'https://example.com' }, 0).includes('复制链接'), true);
    assert.equal(h.ctx.resultActions({ type: 'unknown' }, 0), '', '没有动作就不渲染操作栏');
  }

  {
    // 操作栏插在结果行内部；工具结果自带按钮，不再重复渲染。
    const h = harness();
    const html = h.ctx.renderResult(webItem(), 0, [webItem()]);
    assert.match(html, /<span class="result-actions">[\s\S]*<\/span>\s*<\/div>\s*$/, '操作栏在行内、行尾闭合之前');
    h.ctx.window.FlowHubTools.render = () => '<div class="result tool"></div>';
    assert.doesNotMatch(h.ctx.renderResult({ type: 'ping', toolId: 'ping' }, 0, []), /result-actions/);
  }

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

  {
    // 快捷键说明只列当前可用的操作，并跟随选中结果变化。
    const h = harness();
    h.ctx.state.scope = 'all';
    h.ctx.updateKeyboardHint(webItem());
    assert.match(h.hint(), /↑↓ 选择结果/);
    assert.match(h.hint(), /<kbd>⏎<\/kbd> 打开/);
    assert.match(h.hint(), /<kbd>F6<\/kbd> 操作按钮/);
    assert.match(h.hint(), /<kbd>Tab<\/kbd> 范围/);
    assert.match(h.hint(), /<kbd>⌘K<\/kbd> 回到搜索框/);
    assert.doesNotMatch(h.hint(), /置顶|纯文本粘贴|编辑副本|删除/, '非剪贴板结果不显示剪贴板快捷键');

    h.ctx.updateKeyboardHint({ type: 'memo', content: 'ls' });
    assert.match(h.hint(), /<kbd>⏎<\/kbd> 粘贴/, '备忘回车是粘贴');

    h.ctx.updateKeyboardHint({ type: 'clipboard', id: 1, kind: 'text' });
    assert.match(h.hint(), /<kbd>⇧⏎<\/kbd> 纯文本粘贴/);
    assert.match(h.hint(), /<kbd>⌘D<\/kbd> 置顶/);
    assert.match(h.hint(), /<kbd>⌘E<\/kbd> 编辑副本/);
    assert.match(h.hint(), /<kbd>⌥⌫<\/kbd> 删除/);

    h.ctx.updateKeyboardHint({ type: 'clipboard', id: 2, kind: 'image' });
    assert.doesNotMatch(h.hint(), /纯文本粘贴|编辑副本/, '图片记录不显示不可用的操作');
    assert.match(h.hint(), /⌘D/);

    h.ctx.document.documentElement.dataset.weborgReadonly = 'true';
    h.ctx.updateKeyboardHint({ type: 'clipboard', id: 1, kind: 'text' });
    assert.doesNotMatch(h.hint(), /删除/, '浏览器预览不显示删除快捷键');

    h.ctx.state.scope = 'clipboard';
    h.ctx.updateKeyboardHint({ type: 'clipboard', id: 1, kind: 'text' });
    assert.doesNotMatch(h.hint(), /常用\/最近/, '专属范围没有常用/最近横排');

    h.ctx.updateKeyboardHint({ type: 'unknown' });
    assert.doesNotMatch(h.hint(), /F6/, '没有操作按钮的结果不提示 F6');
  }

  console.log('PASS: results expose one action bar per type and F6/Tab/Escape follow one focus order');
})().catch(error => { console.error(error); process.exitCode = 1; });
