const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../ui/shared/command-store.js'), 'utf8');

function harness() {
  const data = new Map();
  const window = {
    localStorage: {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: (key) => data.delete(key)
    }
  };
  const ctx = vm.createContext({ window, Date, JSON, Array, Object, String, Number, Map, Set, Math, console });
  vm.runInContext(source, ctx);
  return { store: window.FlowHubCommandStore, window, data };
}

(async () => {
  {
    // 记录：同一工具的同一查询只留一条并刷新时间，列表按最近执行排在前面。
    const h = harness();
    assert.equal(h.store.history.list('ping').length, 0);
    const first = h.store.history.record('ping', '  ping example.com  ', { at: 1000 });
    assert.equal(first.recorded, true);
    assert.equal(first.kept, 1);
    h.store.history.record('curl', 'curl https://example.com', { at: 1001 });
    h.store.history.record('ping', 'ping example.com', { at: 1002, params: { host: 'example.com' } });

    const recent = h.store.history.list('ping');
    assert.equal(recent.length, 1, '同一查询不重复记录');
    assert.equal(recent[0].query, 'ping example.com', '查询串去掉首尾空白');
    assert.equal(recent[0].at, 1002, '重复执行刷新时间');
    assert.equal(recent[0].params.host, 'example.com');
    assert.equal(h.store.history.list().length, 2);
    assert.equal(h.store.history.list()[0].toolId, 'ping', '最近执行的排在最前');
  }

  {
    // 上限：每工具 20 条、历史总量 100 条，超出的按最旧先丢。
    const h = harness();
    for (let index = 0; index < 25; index += 1) h.store.history.record('ping', `ping host-${index}`, { at: index });
    const pings = h.store.history.list('ping');
    assert.equal(pings.length, 20, '每工具只保留 20 条');
    assert.equal(pings[0].query, 'ping host-24', '保留最近的一条');
    assert.equal(pings[19].query, 'ping host-5', '最旧的被丢掉');

    for (const tool of ['curl', 'port', 'dns', 'ip', 'localIp']) {
      for (let index = 0; index < 20; index += 1) h.store.history.record(tool, `${tool} value-${index}`, { at: index });
    }
    assert.equal(h.store.counts().total, 100, '历史总量上限 100 条');
    assert.ok(JSON.parse(h.data.get('flowhub:command-history:v1')).length <= 100, '落盘的条数不超过上限');
  }

  {
    // 敏感内容不写入：URL 凭据、密钥类查询参数、curl 凭据参数与 Authorization 头。
    const h = harness();
    const sensitive = [
      'curl https://user:pass@example.com/',
      'curl https://example.com/?token=abc123',
      'curl https://example.com/?api_key=abc123',
      'curl https://example.com/?session=deadbeef',
      'curl -u admin:secret https://example.com/',
      'curl --password=secret https://example.com/',
      'curl -H "Authorization: Bearer abcdefgh" https://example.com/'
    ];
    for (const query of sensitive) {
      assert.equal(h.store.isSensitive(query), true, `${query} 应判为敏感`);
      const result = h.store.history.record('curl', query);
      assert.equal(result.recorded, false);
      assert.equal(result.reason, 'sensitive');
    }
    assert.equal(h.store.history.list().length, 0, '敏感查询不落盘');
    assert.equal(h.store.isSensitive('curl https://example.com/path?page=2'), false);
    assert.equal(h.store.isSensitive('ping 192.168.1.1'), false);
    assert.equal(h.store.history.record('ping', '   ').reason, 'empty');
    // 模板同样拒绝敏感内容。
    assert.equal(h.store.templates.save('curl', { query: sensitive[1] }).reason, 'sensitive');
  }

  {
    // 参数模板：每工具 10 个，可单独删除或整个工具清空。
    const h = harness();
    for (let index = 0; index < 12; index += 1) {
      h.store.templates.save('port', { query: `port ${8000 + index}`, params: { port: String(8000 + index) }, at: index });
    }
    const saved = h.store.templates.list('port');
    assert.equal(saved.length, 10);
    assert.equal(saved[0].params.port, '8011');
    assert.equal(saved[9].params.port, '8002');

    h.store.templates.forget('port', saved[0].id);
    assert.equal(h.store.templates.list('port').length, 9);
    h.store.templates.clear('port');
    assert.equal(h.store.templates.list('port').length, 0);
    assert.equal(h.store.templates.list('curl').length, 0);
  }

  {
    // 清空与汇总：设置页的清空按钮要同时清掉历史和模板。
    const h = harness();
    h.store.history.record('ping', 'ping example.com');
    h.store.history.record('ping', 'ping example.org');
    h.store.history.record('port', 'port 9000');
    h.store.templates.save('port', { query: 'port 9000' });
    const counts = h.store.counts();
    assert.equal(counts.total, 3);
    assert.equal(counts.templates, 1);
    assert.equal(JSON.stringify(counts.byTool), '{"ping":2,"port":1}');

    h.store.clearAll();
    assert.equal(JSON.stringify(h.store.counts()), '{"total":0,"templates":0,"byTool":{}}');
  }

  {
    // 时间描述与面板：面板只在有历史时列出「最近执行」，未转义内容要转义。
    const h = harness();
    const now = Date.UTC(2026, 8, 17, 12, 0, 0);
    assert.equal(h.store.formatAge(now - 5_000, now), '刚刚');
    assert.equal(h.store.formatAge(now - 120_000, now), '2 分钟前');
    assert.equal(h.store.formatAge(now - 7_200_000, now), '2 小时前');
    assert.match(h.store.formatAge(now - 3 * 86_400_000, now), /^\d{4}-\d{2}-\d{2}$/);

    const empty = h.store.panelHtml('ping', String);
    assert.doesNotMatch(empty, /最近执行/, '没有历史时不显示最近执行');
    assert.match(empty, /还没有模板/);

    h.store.history.record('ping', 'ping <script>');
    h.store.templates.save('ping', { query: 'ping 10.0.0.1', params: { host: '10.0.0.1' } });
    const html = h.store.panelHtml('ping', (value) => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
    assert.match(html, /最近执行/);
    assert.match(html, /data-tool-action="history-run"/);
    assert.match(html, /data-tool-action="history-copy"/);
    assert.match(html, /data-tool-action="template-run"/);
    assert.match(html, /data-tool-action="history-clear"/);
    assert.match(html, /ping &lt;script&gt;/, '查询串按传入的 esc 转义');
    assert.match(html, /host=10\.0\.0\.1/, '模板显示参数');

    // 单个工具的清理不影响其它工具。
    h.store.history.record('curl', 'curl https://example.com');
    h.store.history.clear('ping');
    assert.equal(h.store.history.list('ping').length, 0);
    assert.equal(h.store.history.list('curl').length, 1);
  }

  {
    // 存储不可用（隐私模式或配额满）时退化成不记录，不抛异常。
    const ctx = vm.createContext({ window: { localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } }, Date, JSON, Array, Object, String, Number, Map, Set, Math, console });
    vm.runInContext(source, ctx);
    const store = ctx.window.FlowHubCommandStore;
    assert.equal(store.history.record('ping', 'ping example.com').recorded, true, '写入失败仍返回已记录，界面不报错');
    assert.equal(store.history.list().length, 0);
    assert.equal(JSON.stringify(store.counts()), '{"total":0,"templates":0,"byTool":{}}');
  }

  console.log('PASS: command history and parameter templates are bounded, clearable and skip credentials');
})().catch(error => { console.error(error); process.exitCode = 1; });
