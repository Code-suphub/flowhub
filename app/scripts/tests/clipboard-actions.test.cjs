const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../ui/search/search.js'), 'utf8');
const slice = source.slice(source.indexOf('function clipboardTextHtml('), source.indexOf('const resultWindow = new window.FlowHubResultWindow();'));

function harness() {
  const calls = [];
  const status = [];
  let refreshed = 0;
  const editor = { value: '', focused: false, dataset: { clipboardEditor: '' }, tagName: 'TEXTAREA', focus() { this.focused = true; } };
  const elements = { '.clipboard-editor': editor };
  const window = {
    weborg: {
      pluginAction: (id, action, payload) => {
        calls.push({ id, action, payload });
        return Promise.resolve(window.weborg.pluginResult ?? { ok: true });
      },
      pluginResult: { ok: true }
    },
    FlowHubTools: { render: () => null }
  };
  const ctx = vm.createContext({
    console, URL, JSON, Number, String, Object, Array, Set, Map, Date, Boolean, Math, Promise,
    window,
    state: { index: 0, clipboardResults: [], expandedClipboard: new Set(), editingClipboard: null },
    esc: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    formatTime: () => '刚刚',
    formatBytes: (value) => `${value} B`,
    iconHtml: () => '<span class="icon"></span>',
    pathText: () => '',
    noteOf: () => '',
    normalizeUrl: (value) => value || '',
    usageSectionHeading: () => '',
    portableQueryCommand: () => null,
    resultWindow: { heights: new Map() },
    resultKey: (item) => `${item.type}:${item.id}`,
    lastResultsHtml: '',
    getComputedStyle: () => ({ marginTop: '0', marginBottom: '0' }),
    resultsEl: { querySelector: (selector) => elements[selector] || null },
    render: () => {},
    returnToSearch: () => { ctx.returned = true; },
    showActionStatus: (message) => status.push(message),
    refreshClipboard: () => { refreshed += 1; return Promise.resolve(); },
    document: { documentElement: { dataset: {} } }
  });
  vm.runInContext(slice, ctx);
  return {
    ctx, calls, status, editor, window,
    refreshed: () => refreshed,
    textItem: (extra = {}) => ({
      type: 'clipboard', pluginId: 'clipboard', id: 7, kind: 'text', content: 'hello',
      hash: 'a'.repeat(64), copyCount: 2, lastSeenAt: '2026-09-09T00:00:00Z', size: 5, ...extra
    })
  };
}

(async () => {
  {
    // 文本记录：置顶、纯文本粘贴、编辑副本都提供，并标注快捷键。
    const h = harness();
    const html = h.ctx.renderResultBody(h.textItem(), 0, [h.textItem()]);
    assert.match(html, /data-clipboard-action="pin"/);
    assert.match(html, /☆ 置顶（⌘D）/);
    assert.match(html, /纯文本粘贴（⇧↩）/);
    assert.match(html, /编辑副本（⌘E）/);
    assert.doesNotMatch(html, /已置顶/, '未置顶时不显示标记');

    const pinned = h.ctx.renderResultBody(h.textItem({ pinnedAt: '2026-09-09T00:00:00Z' }), 0, [h.textItem()]);
    assert.match(pinned, /★ 已置顶/);
    assert.match(pinned, /★ 取消置顶（⌘D）/);
    assert.match(pinned, /data-clipboard-pinned="false"/);
  }

  {
    // 图片记录没有文本，不提供纯文本粘贴与编辑；文件记录可以粘贴路径。
    const h = harness();
    const image = h.ctx.renderResultBody({
      type: 'clipboard', id: 8, kind: 'image', hash: 'b'.repeat(64), copyCount: 1,
      lastSeenAt: '2026-09-09T00:00:00Z', size: 100
    }, 0, []);
    assert.match(image, /data-clipboard-action="pin"/);
    assert.doesNotMatch(image, /纯文本粘贴/);
    assert.doesNotMatch(image, /编辑副本/);

    const file = h.ctx.renderResultBody({
      type: 'clipboard', id: 9, kind: 'file', hash: 'c'.repeat(64), copyCount: 1,
      lastSeenAt: '2026-09-09T00:00:00Z', size: 10, fileNames: ['a.txt'], fileCount: 1, fileType: 'file'
    }, 0, []);
    assert.match(file, /纯文本粘贴（⇧↩）/);
    assert.doesNotMatch(file, /编辑副本/);
  }

  {
    // 编辑态：渲染编辑框与保存/取消，保存写入新记录并刷新列表。
    const h = harness();
    const item = h.textItem();
    h.ctx.state.clipboardResults = [item];
    h.ctx.startClipboardEdit(item);
    assert.equal(h.ctx.state.editingClipboard.text, 'hello');
    assert.equal(h.editor.focused, true, '打开编辑框后自动聚焦');

    const html = h.ctx.renderResultBody(item, 0, [item]);
    assert.match(html, /data-clipboard-action="edit-save"/);
    assert.match(html, /data-clipboard-action="edit-cancel"/);
    assert.match(html, />hello</);
    assert.doesNotMatch(html, /data-clipboard-toggle/, '编辑时不显示展开按钮');

    h.editor.value = '  改过的文本  ';
    await h.ctx.saveClipboardEdit();
    assert.equal(h.calls.at(-1).action, 'edit');
    assert.equal(h.calls.at(-1).payload.content, '  改过的文本  ');
    assert.equal(h.calls.at(-1).payload.id, 7);
    assert.equal(h.ctx.state.editingClipboard, null);
    assert.equal(h.refreshed(), 1);
    assert.ok(h.status.includes('已保存为新的文本记录，原记录保留'));
  }

  {
    // 空白内容不提交；取消后回到搜索框；非文本记录直接提示。
    const h = harness();
    const item = h.textItem();
    h.ctx.state.clipboardResults = [item];
    h.ctx.startClipboardEdit(item);
    h.editor.value = '   ';
    await h.ctx.saveClipboardEdit();
    assert.equal(h.calls.length, 0, '空白内容不发请求');
    assert.equal(h.ctx.state.editingClipboard.id, 7, '保留编辑态');
    assert.ok(h.status.includes('编辑后的内容不能为空'));

    h.ctx.cancelClipboardEdit();
    assert.equal(h.ctx.state.editingClipboard, null);
    assert.equal(h.ctx.returned, true);

    h.ctx.startClipboardEdit({ type: 'clipboard', id: 9, kind: 'file' });
    assert.equal(h.ctx.state.editingClipboard, null, '文件记录不能编辑');
    assert.ok(h.status.includes('只有文本记录可以编辑副本'));
  }

  {
    // 置顶：翻转 pinned 后刷新；失败时不动列表。
    const h = harness();
    const item = h.textItem();
    await h.ctx.toggleClipboardPin(item);
    assert.equal(JSON.stringify(h.calls.at(-1)), '{"id":"clipboard","action":"pin","payload":{"id":7,"pinned":true}}');
    assert.equal(h.refreshed(), 1);
    assert.ok(h.status.includes('已置顶，过期清理不会删除'));

    await h.ctx.toggleClipboardPin(h.textItem({ pinnedAt: 'now' }));
    assert.equal(h.calls.at(-1).payload.pinned, false);
    assert.ok(h.status.includes('已取消置顶'));

    h.window.weborg.pluginResult = { ok: false, reason: '剪贴板记录不存在或已删除' };
    await h.ctx.toggleClipboardPin(item);
    assert.equal(h.refreshed(), 2, '失败时不刷新也不会再次刷新');
    assert.ok(h.status.includes('剪贴板记录不存在或已删除'));
  }

  {
    // 纯文本粘贴：文本与文件都发 plain，图片直接提示不请求。
    const h = harness();
    await h.ctx.pasteClipboardPlain(h.textItem());
    assert.equal(h.calls.at(-1).action, 'plain');
    assert.equal(h.calls.at(-1).payload.id, 7);
    await h.ctx.pasteClipboardPlain({ type: 'clipboard', id: 9, kind: 'file' });
    assert.equal(h.calls.at(-1).action, 'plain');
    const before = h.calls.length;
    await h.ctx.pasteClipboardPlain({ type: 'clipboard', id: 8, kind: 'image' });
    assert.equal(h.calls.length, before, '图片不发请求');
    assert.ok(h.status.includes('图片记录没有可粘贴的文本'));
  }

  {
    // 浏览器预览只读时全部拒绝，且不发请求。
    const h = harness();
    h.ctx.document.documentElement.dataset.weborgReadonly = 'true';
    const result = await h.ctx.clipboardAction('pin', h.textItem(), { pinned: true });
    assert.equal(result.ok, false);
    assert.equal(h.calls.length, 0);
    assert.ok(h.status.includes('浏览器预览不能修改剪贴板'));
  }

  console.log('PASS: clipboard results expose pin, plain-text paste and edit-copy with shortcuts and guards');
})().catch(error => { console.error(error); process.exitCode = 1; });
