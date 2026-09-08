// Isolated synthetic data; the baseline is the source before review item 10.
// Run: node --expose-gc scripts/web-search-benchmark.cjs
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const current = require('../ui/web-search.js');
const context = vm.createContext({ module: { exports: {} } });
vm.runInContext(execFileSync('git', ['show', '588cdca772c71a0b5cf6e95d5bb262129ad632e0:app/ui/web-search.js'], { encoding: 'utf8' }), context);
const baseline = context.module.exports;
const pages = Array.from({ length: 10000 }, (_, id) => ({ id, title: `工具 GitHub ${id % 37} reference ${id}`,
  url: `https://example${id % 13}.test/docs/${id}`, note: `开发 reference 文档 ${id % 19}`,
  path: [{ title: `分类 ${id % 17}` }, { title: '开发' }, { title: `工具 ${id}` }] }));
const queries = ['g', 'gi', 'git', 'github', '工具GitHub', 'reference 开发', 'example3', 'missing', ' / ', ''];
const index = current.createWebPageIndex(pages);
for (const query of queries) for (const offset of [0, 12, 96, 9990]) {
  assert.deepEqual(index.search(query, 12, offset).map(x => x.id), Array.from(baseline.rankWebPages(pages, query, 12, offset), x => x.id));
}
function measure(fn, count = 15) {
  const values = [];
  for (let i = 0; i < count + 3; i++) {
    const start = performance.now(); fn();
    if (i >= 3) values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  return { medianMs: +values[Math.floor(values.length / 2)].toFixed(3), p95Ms: +values[Math.ceil(values.length * .95) - 1].toFixed(3) };
}
const results = {
  baselineCold: measure(() => baseline.rankWebPages(pages, 'github')),
  indexedCold: measure(() => current.createWebPageIndex(pages).search('github')),
  baselineTyping: measure(() => queries.forEach(q => baseline.rankWebPages(pages, q)), 7),
  indexedTyping: measure(() => queries.forEach(q => index.search(q)), 7),
  baselineTenPages: measure(() => { for (let i = 0; i < 10; i++) baseline.rankWebPages(pages, 'github', 12, i * 12); }, 7),
  indexedTenPages: measure(() => { index.search('github'); for (let i = 0; i < 10; i++) index.search('github', 12, i * 12); }, 7)
};
if (global.gc) {
  global.gc(); const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 2000; i++) index.search(`reference ${i}`);
  global.gc(); results.retainedHeapDeltaAfter2000QueriesBytes = process.memoryUsage().heapUsed - before;
}
console.log(JSON.stringify({ pages: pages.length, equivalenceCases: queries.length * 4, ...results }, null, 2));
