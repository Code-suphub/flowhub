const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../ui/settings.js'), 'utf8');
const save = source.slice(source.indexOf('async function save()'), source.indexOf('async function reload()'));
const clone = value => JSON.parse(JSON.stringify(value));
(async () => {
  for (const mode of ['form', 'json']) {
    const original = {plugins: {web: {settings: {items: [{id: 'A-draft'}]}}}};
    const committed = {plugins: {web: {settings: {items: [{id: 'B'}], catalogCount: 1}}}};
    const state = {mode, config: original, dirty: true};
    let broadcastConfig, message, cleared;
    const context = vm.createContext({
      state, clone, normalizeConfig: value => value, readJsonEditor: () => original,
      draftStorageKey: () => 'old-draft', clearDraft: key => {cleared = key},
      render: () => { broadcastConfig = clone(state.config) },
      toast: text => { message = text },
      window: {weborg: {
        saveConfig: async submitted => {
          assert.equal(submitted.plugins.web.settings.items[0].id, 'A-draft');
          return {ok: true, config: committed, storageState: {operation: 'open'}};
        },
        listPlugins: async () => [], getClipboardStorageInfo: async () => ({}), getConfigPathInfo: async () => ({}),
      }},
    });
    vm.runInContext(save, context);
    await context.save();
    assert.deepEqual(state.config, committed);
    assert.deepEqual(state.savedConfig, committed);
    assert.deepEqual(broadcastConfig, committed);
    assert.equal(state.dirty, false);
    assert.equal(cleared, 'old-draft');
    assert.match(message, /已打开目标数据库/);
  }
  console.log('PASS: form and JSON storage saves adopt target catalog and explain open semantics');
})().catch(error => {console.error(error); process.exitCode = 1});
