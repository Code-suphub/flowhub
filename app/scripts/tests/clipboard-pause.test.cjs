const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../ui/search/search.js'), 'utf8');
const slice = source.slice(
  source.indexOf('// 临时暂停只在本次运行内生效'),
  source.indexOf('// Pinning applies for this app session')
);

function harness(weborg = {}) {
  const status = [];
  const calls = [];
  const nodes = {
    clipboardPauseBtn: { hidden: false, disabled: false, textContent: '', title: '', dataset: {}, listeners: {}, setAttribute(name, value) { this[name] = value; }, addEventListener(type, fn) { this.listeners[type] = fn; } },
    clipboardPauseState: { textContent: '' }
  };
  const ctx = vm.createContext({
    console, JSON, Number, String, Object, Array, Promise,
    document: { getElementById: (id) => nodes[id] || null },
    showActionStatus: (message) => status.push(message),
    window: {
      weborg: {
        getClipboardCaptureState: async () => ({ enabled: true, paused: false }),
        setClipboardTemporaryPause: async (paused) => { calls.push(paused); return { ok: true, paused }; },
        ...weborg
      }
    }
  });
  vm.runInContext(slice, ctx);
  return { ctx, nodes, status, calls, button: nodes.clipboardPauseBtn, label: nodes.clipboardPauseState };
}

(async () => {
  {
    // 各种状态下按钮文案、状态提示与可用性。
    const h = harness();
    h.ctx.renderClipboardPauseState({ enabled: true, paused: false, temporaryPaused: false, configuredPaused: false });
    assert.equal(h.button.hidden, false);
    assert.equal(h.button.disabled, false);
    assert.equal(h.button.textContent, '暂停记录');
    assert.equal(h.button['aria-pressed'], 'false');
    assert.equal(h.label.textContent, '');
    assert.match(h.button.title, /临时暂停/);

    h.ctx.renderClipboardPauseState({ enabled: true, paused: true, temporaryPaused: true });
    assert.equal(h.button.textContent, '恢复记录');
    assert.equal(h.button['aria-pressed'], 'true');
    assert.equal(h.label.textContent, '已暂停记录（本次运行）');

    h.ctx.renderClipboardPauseState({ enabled: true, paused: true, configuredPaused: true });
    assert.equal(h.label.textContent, '已在设置中暂停采集');
    assert.match(h.button.title, /配置文件里已暂停/);

    h.ctx.renderClipboardPauseState({ enabled: true, blockedByExclusions: true, paused: true });
    assert.equal(h.button.textContent, '记录已阻止');
    assert.equal(h.button.disabled, true, '排除名单阻止采集时不能靠临时暂停恢复');
    assert.equal(h.label.textContent, '已阻止采集（排除名单）');
    assert.match(h.button.title, /设置中清空旧列表/);

    h.ctx.renderClipboardPauseState({ enabled: false });
    assert.equal(h.button.hidden, true, '剪贴板停用时隐藏暂停按钮');
    assert.equal(h.label.textContent, '剪贴板已停用');

    h.ctx.renderClipboardPauseState({ enabled: false, preview: true });
    assert.equal(h.label.textContent, '', '浏览器预览不显示状态');
  }

  {
    // 点击：按当前状态取反，成功后刷新按钮与状态提示。
    const h = harness();
    h.ctx.renderClipboardPauseState({ enabled: true, paused: false });
    await h.button.listeners.click();
    assert.deepEqual(h.calls, [true]);
    assert.equal(h.button.textContent, '恢复记录');
    assert.equal(h.label.textContent, '已暂停记录（本次运行）');
    assert.equal(h.status.at(-1), '已临时暂停剪贴板记录（本次运行）');
    assert.equal(h.button.disabled, false);

    await h.button.listeners.click();
    assert.deepEqual(h.calls, [true, false]);
    assert.equal(h.button.textContent, '暂停记录');
    assert.equal(h.status.at(-1), '已恢复剪贴板记录');
  }

  {
    // 失败时给出提示并保持按钮可用；读取状态失败时按钮保持隐藏。
    const h = harness({ setClipboardTemporaryPause: async () => { throw new Error('权限不足'); } });
    h.ctx.renderClipboardPauseState({ enabled: true, paused: false });
    await h.button.listeners.click();
    assert.equal(h.status.at(-1), '暂停失败：权限不足');
    assert.equal(h.button.disabled, false);

    const failing = harness({ getClipboardCaptureState: async () => { throw new Error('不可用'); } });
    await failing.ctx.loadClipboardCaptureState();
    assert.equal(failing.button.hidden, true, '读不到状态时不显示按钮');

    const loading = harness();
    await loading.ctx.loadClipboardCaptureState();
    assert.equal(loading.button.hidden, false);
    assert.equal(loading.button.textContent, '暂停记录');
  }

  {
    // 没有对应 IPC 时按钮保持隐藏，不显示不可用的操作。
    const onlyButton = { hidden: false, dataset: {}, addEventListener() {}, setAttribute() {} };
    const ctx = vm.createContext({
      console, JSON, Number, String, Object, Array, Promise,
      document: { getElementById: (id) => (id === 'clipboardPauseBtn' ? onlyButton : null) },
      showActionStatus: () => {},
      window: { weborg: {} }
    });
    vm.runInContext(slice, ctx);
    assert.equal(onlyButton.hidden, true);
  }

  console.log('PASS: clipboard temporary pause is one click away, labelled and guarded per state');
})().catch(error => { console.error(error); process.exitCode = 1; });
