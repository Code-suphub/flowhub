const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '../../ui', file), 'utf8');

function harness() {
  const data = new Map();
  const timers = [];
  const window = {
    localStorage: {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: (key) => data.delete(key)
    }
  };
  const ctx = vm.createContext({
    window, URL, Date, JSON, Array, Object, String, Number, Map, Set, Math, Promise, console,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {}
  });
  for (const file of ['search/tool-registry.js', 'shared/command-store.js', 'search/network-tools.js', 'search/port-tool.js']) {
    vm.runInContext(read(file), ctx);
  }
  return {
    tools: window.FlowHubTools,
    store: window.FlowHubCommandStore,
    // 端口工具用 180ms 防抖自动查询，测试里手动触发最后一次排队的回调。
    flush() { const pending = timers.splice(0, timers.length); for (const fn of pending) fn(); }
  };
}

function networkContext(query) {
  const log = [];
  const ctx = {
    query,
    queryNow: () => ctx.query,
    enabled: () => true,
    render() {},
    status: (message) => log.push(message),
    copy: async (text) => { ctx.copied = text; },
    setQuery: (text) => { ctx.query = text; },
    calls: [],
    api: { runNetworkDiagnostic: async (kind, target, head) => { ctx.calls.push(`${kind}:${target}:${head}`); return { output: 'ok', exitCode: 0, elapsedMs: 3 }; } }
  };
  ctx.log = log;
  return ctx;
}

function button(commandId) {
  return { dataset: { commandId } };
}

(async () => {
  {
    // ping／curl 只在真正执行后写入历史，改查询串不写；敏感查询连执行都不留记录。
    const h = harness();
    const ctx = networkContext('ping example.com');
    const item = h.tools.suggestions(ctx)[0];
    h.tools.queryChanged(ctx);
    assert.equal(h.store.history.list('ping').length, 0, '只是输入不写历史');

    await h.tools.choose(item, ctx);
    assert.equal(h.store.history.list('ping').length, 1);
    assert.equal(h.store.history.list('ping')[0].query, 'ping example.com');
    assert.equal(h.store.history.list('ping')[0].params.host, 'example.com');

    ctx.query = 'curl https://example.com/?token=abc123';
    await h.tools.choose(h.tools.suggestions(ctx)[0], ctx);
    assert.equal(h.store.history.list('curl').length, 0, '带 token 的查询不落盘');
    assert.ok(ctx.log.includes('这条命令带凭据或密钥，没有写入历史'), '提示没有写入历史');
  }

  {
    // 执行失败（桌面能力不可用）不写历史，避免把没跑过的命令记成执行过。
    const h = harness();
    const ctx = networkContext('ping example.com');
    ctx.api = {};
    const item = h.tools.suggestions(ctx)[0];
    await h.tools.choose(item, ctx);
    assert.equal(h.store.history.list('ping').length, 0);
    const html = h.tools.render(item, { esc: String, index: 0, active: true, enabled: ctx.enabled });
    assert.match(html, /本机执行仅在桌面版可用/, '失败原因仍在结果里说明');
    assert.doesNotMatch(html, /最近执行/);
  }

  {
    // 模板：当前查询存成参数模板，复制的是重新校验后生成的实际命令。
    const h = harness();
    const ctx = networkContext('curl -I https://example.com/');
    await h.tools.choose(h.tools.suggestions(ctx)[0], ctx);
    await h.tools.action('curl', 'template-save', {}, ctx);
    const saved = h.store.templates.list('curl');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].query, 'curl -I https://example.com/');
    assert.equal(saved[0].params.method, 'HEAD');
    assert.equal(saved[0].params.url, 'https://example.com/');
    assert.ok(ctx.log.includes('已存为参数模板'));

    ctx.copied = '';
    await h.tools.action('curl', 'template-copy', button(saved[0].id), ctx);
    assert.match(ctx.copied, /^curl -q --head /, '复制的是实际命令');
    assert.ok(ctx.copied.includes("--url 'https://example.com/'"));

    // 参数非法时不能存模板：先清空查询。
    ctx.query = 'curl not-a-url';
    await h.tools.action('curl', 'template-save', {}, ctx);
    assert.equal(h.store.templates.list('curl').length, 1, '不合法查询不新增模板');
  }

  {
    // 重新执行：查询串回到搜索框后按原参数再跑一次；参数失效的记录给出提示。
    const h = harness();
    const ctx = networkContext('ping 10.0.0.1');
    await h.tools.choose(h.tools.suggestions(ctx)[0], ctx);
    const entry = h.store.history.list('ping')[0];

    ctx.query = 'curl https://example.org/';
    ctx.calls.length = 0;
    await h.tools.action('ping', 'history-run', button(entry.id), ctx);
    assert.equal(ctx.query, 'ping 10.0.0.1', '查询串回到输入框');
    assert.equal(ctx.calls.join(','), 'ping:10.0.0.1:false');
    assert.equal(h.store.history.list('ping')[0].id, entry.id);

    const forged = { id: 'ping:forged', toolId: 'ping', query: 'ping -c 100', params: {}, at: Date.now() };
    h.store.history.record('ping', forged.query);
    const stored = h.store.history.list('ping').find((item) => item.query === 'ping -c 100');
    ctx.query = 'ping 10.0.0.1';
    ctx.calls.length = 0;
    await h.tools.action('ping', 'history-run', button(stored.id), ctx);
    assert.equal(ctx.calls.length, 0, '参数不合法的记录不执行');
    assert.ok(ctx.log.includes('这条记录的参数已不可用，请重新输入'));

    // 移除与清空。
    await h.tools.action('ping', 'history-forget', button(entry.id), ctx);
    assert.equal(h.store.history.list('ping').some((item) => item.id === entry.id), false);
    await h.tools.action('ping', 'history-clear', {}, ctx);
    assert.equal(h.store.history.list('ping').length, 0);
  }

  {
    // 关闭记录开关后既不写历史，也不在结果里显示面板。
    const h = harness();
    const ctx = networkContext('ping example.com');
    ctx.enabled = () => false;
    // 关闭后工具本身也不会出现在建议里，这里直接构造结果项验证记录与面板。
    const item = { id: 'network:ping:example.com:false', toolId: 'ping', type: 'network', q: { kind: 'ping', target: 'example.com', head: false } };
    await h.tools.choose(item, ctx);
    assert.equal(h.store.history.list().length, 0, '关闭后不写历史');
    const html = h.tools.render(item, { esc: String, index: 0, active: true, enabled: ctx.enabled });
    assert.doesNotMatch(html, /最近执行/);
    assert.doesNotMatch(html, /参数模板/);
  }

  {
    // 面板内容：执行过的查询、参数模板和历史都在结果里，可点按钮。
    const h = harness();
    const ctx = networkContext('ping example.com');
    await h.tools.choose(h.tools.suggestions(ctx)[0], ctx);
    await h.tools.action('ping', 'template-save', {}, ctx);
    const html = h.tools.render(h.tools.suggestions(ctx)[0], { esc: String, index: 0, active: true, enabled: ctx.enabled });
    assert.match(html, /最近执行/);
    assert.match(html, /ping example\.com/);
    assert.match(html, /data-tool-action="history-run"/);
    assert.match(html, /data-tool-action="template-run"/);
    assert.match(html, /host=example\.com/);
  }

  {
    // 端口：自动预览不写历史，回车与「刷新」才记录；复制的是该端口对应的实际命令。
    const h = harness();
    const log = [];
    const ctx = {
      query: 'port 9000',
      active: true,
      queryNow: () => ctx.query,
      enabled: () => true,
      render() {},
      status: (message) => log.push(message),
      copy: async (text) => { ctx.copied = text; },
      setQuery: (text) => { ctx.query = text; },
      inspected: [],
      api: { inspectPort: async (port) => { ctx.inspected.push(port); return { port, processes: [], status: 'ready' }; } }
    };
    ctx.log = log;
    h.tools.queryChanged(ctx);
    h.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(ctx.inspected, [9000], '自动预览会检查端口');
    assert.equal(h.store.history.list('port').length, 0, '自动预览不写历史');

    await h.tools.action('port', 'refresh', { dataset: {} }, ctx);
    assert.equal(h.store.history.list('port').length, 1);
    assert.equal(h.store.history.list('port')[0].query, 'port 9000');
    assert.equal(h.store.history.list('port')[0].params.port, '9000');

    await h.tools.choose({ toolId: 'port', port: 9000, details: { status: 'ready', processes: [] } }, ctx);
    assert.equal(h.store.history.list('port').length, 1, '同一端口只留一条');
    assert.ok(ctx.log.includes('端口详情已复制'));

    const entry = h.store.history.list('port')[0];
    ctx.copied = '';
    await h.tools.action('port', 'history-copy', button(entry.id), ctx);
    assert.match(ctx.copied, /lsof -nP -iTCP:\$PORT -sTCP:LISTEN/);

    await h.tools.action('port', 'template-save', {}, ctx);
    const template = h.store.templates.list('port')[0];
    assert.equal(template.params.port, '9000');

    ctx.query = 'port 1';
    await h.tools.action('port', 'template-run', button(template.id), ctx);
    assert.equal(ctx.query, 'port 9000', '模板把参数填回搜索框');
    assert.ok(log.some((message) => message.includes('已填入端口 9000')));

    ctx.query = 'port 99999';
    await h.tools.action('port', 'template-save', {}, ctx);
    assert.equal(h.store.templates.list('port').length, 1, '超范围端口不存模板');
  }

  {
    // 端口面板同样跟随记录开关。
    const h = harness();
    const ctx = {
      query: 'port 9000', active: true, queryNow: () => ctx.query, enabled: (key) => key !== 'commandHistory',
      render() {}, status() {}, copy: async () => {}, setQuery() {},
      api: { inspectPort: async (port) => ({ port, processes: [], status: 'ready' }) }
    };
    await h.tools.action('port', 'refresh', { dataset: {} }, ctx);
    assert.equal(h.store.history.list('port').length, 0);
    const html = h.tools.render({ toolId: 'port', port: 9000, details: { status: 'ready', processes: [] } }, { esc: String, index: 0, active: true, enabled: ctx.enabled });
    assert.doesNotMatch(html, /最近执行/);
  }

  console.log('PASS: ping, curl and port record executed commands, replay them and keep credentials out');
})().catch(error => { console.error(error); process.exitCode = 1; });
