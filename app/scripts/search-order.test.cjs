const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../ui/search.js'), 'utf8');
const state = { scope: 'all', query: 'flow', config: {} };
const ctx = vm.createContext({
  state, pluginEnabled: () => true,
  clipboardMatches: () => [{ type: 'clipboard', id: 'clip' }],
  appMatches: () => [{ type: 'app', id: 'app' }],
  pageMatches: () => [{ id: 'web' }], memoMatches: () => [],
  usageMatches: () => [], toolSuggestions: () => [], webAddSuggestion: () => null,
  withoutUsageDuplicates: (items) => items,
});
vm.runInContext(source.slice(source.indexOf('let allResultKeys'), source.indexOf('function usageIndices')), ctx);
const types = () => Array.from(ctx.matches(), item => item.type);
assert.deepEqual(types(), ['app', 'page', 'clipboard']);
state.config = { core: { webBeforeClipboard: false } };
assert.deepEqual(types(), ['app', 'clipboard', 'page']);
assert.deepEqual(Array.from(ctx.allCandidates(), item => item.type), ['app', 'clipboard', 'page']);
state.query = '';
assert.deepEqual(types(), ['app', 'clipboard', 'page']);
state.scope = 'clipboard';
assert.deepEqual(types(), ['clipboard']);
state.scope = 'app';
assert.deepEqual(types(), ['app']);
state.scope = 'web';
assert.deepEqual(types(), ['page']);
state.scope = 'all';
state.query = 'flow';
ctx.toolSuggestions = () => [{ type: 'tool' }];
assert.equal(types()[0], 'tool');
vm.runInContext(source.slice(source.indexOf('function setConfig('), source.indexOf('function eventMatchesShortcut')), ctx);
vm.runInContext("allResultKeys = ['app:app']; allInitialResults = [{type:'app',id:'app'}]", ctx);
ctx.setConfig({ core: { webBeforeClipboard: true } });
assert.deepEqual(types(), ['tool', 'app', 'page', 'clipboard']);
vm.runInContext(source.slice(source.indexOf('function usageMatches('), source.indexOf('function withoutUsageDuplicates')), ctx);
state.query = '';
state.usageSections = { frequent: [{ type: 'page', id: 'p' }, { type: 'app', id: 'a' }], recent: [] };
assert.deepEqual(Array.from(ctx.usageMatches(), item => item.type), ['app', 'page']);
ctx.setConfig({ core: { searchResultOrder: ['memo', 'clipboard', 'web', 'app'] } });
ctx.memoMatches = () => [{type:'memo', id:'memo'}];
state.query = 'flow';
assert.deepEqual(types(), ['tool', 'memo', 'clipboard', 'page', 'app']);
assert.deepEqual(Array.from(ctx.allCandidates(), item => item.type), ['memo', 'clipboard', 'page', 'app']);
state.query = '';
assert.deepEqual(Array.from(ctx.usageMatches(), item => item.type), ['page', 'app']);
state.usageSections = {};
assert.deepEqual(types(), ['memo', 'clipboard', 'page', 'app']);
assert.deepEqual(Array.from(ctx.configuredSearchOrder({core:{searchResultOrder:['web','web','unknown']}})), ['web','app','clipboard','memo']);
assert.deepEqual(Array.from(ctx.configuredSearchOrder({core:{searchResultOrder:'invalid'}})), ['app','web','clipboard','memo']);
const settings = fs.readFileSync(require('node:path').join(__dirname, '../ui/settings.js'), 'utf8');
const settingsContext = vm.createContext({});
vm.runInContext(settings.slice(settings.indexOf('function configuredSearchOrder('), settings.indexOf('function renderSearchResultOrder(')), settingsContext);
for (const config of [{}, state.config, {core:{webBeforeClipboard:false}}, {core:{searchResultOrder:['web','web','bad']}}]) {
  assert.deepEqual(Array.from(settingsContext.configuredSearchOrder(config)), Array.from(ctx.configuredSearchOrder(config)));
}
console.log('PASS search order: default, opt-out, pagination, empty query, individual scopes, explicit tools');
