const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../ui/search.js'), 'utf8');
let handler, focusCount = 0, selected = 0, prevented = 0;
const q = { value: '已有关键词', focus: () => focusCount++, select: () => selected++ };
const context = vm.createContext({
  q, scopeTabHeld: true, scopeTabUsedWithArrow: true, searchInputComposing: false,
  searchCompositionEndedAt: 0, performance: { now: () => 1000 }, scopeForShortcut: () => null,
  document: { activeElement: {}, getElementById: () => null, addEventListener: (name, fn) => { handler = fn; } },
});
vm.runInContext(source.slice(source.indexOf('function returnToSearch()'), source.indexOf('document.addEventListener("keyup"')), context);
const event = extra => ({ key: 'k', code: 'KeyK', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, target: {}, preventDefault: () => prevented++, ...extra });
handler(event());
assert.equal(focusCount, 1); assert.equal(selected, 1); assert.equal(prevented, 1);
assert.equal(q.value, '已有关键词'); assert.equal(context.scopeTabHeld, false);
for (const extra of [{metaKey: false}, {altKey: true}, {ctrlKey: true}, {shiftKey: true}, {isComposing: true}]) handler(event(extra));
assert.equal(focusCount, 1);
context.searchInputComposing = true; handler(event()); assert.equal(focusCount, 1);
context.searchInputComposing = false; q.value = ''; handler(event()); assert.equal(focusCount, 2); assert.equal(q.value, '');
console.log('PASS: Command+K returns focus, selects without clearing query, resets held scope key, ignores unrelated modifiers and IME composition');
// Native focus must stay with the input throughout a primary mouse press.
const mouse = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function preserveSearchFocus('), source.indexOf('scopeRow?.addEventListener("mousedown"')), mouse);
let cancelled = 0;
const press = (button, control) => mouse.preserveSearchFocus({button, target: {closest: () => control}, preventDefault(){cancelled++;}});
press(0, {}); assert.equal(cancelled, 1);
press(2, {}); press(0, null); assert.equal(cancelled, 1);
// A config refresh during a press retains the same event target and selection.
const children = [];
const root = { querySelectorAll: () => children.slice(), querySelector: () => children[0] || null,
  insertBefore(node, anchor) { const old = children.indexOf(node); if (old >= 0) children.splice(old, 1); const index = anchor ? children.indexOf(anchor) : children.length; children.splice(index, 0, node); }
};
function createButton() {
  const node = { dataset: {}, textContent: '', classList: { toggle(name, active) { node.active = active; } }, remove() { children.splice(children.indexOf(node), 1); } };
  Object.defineProperty(node, 'nextElementSibling', {get: () => children[children.indexOf(node)+1] || null});
  return node;
}
const scopes = vm.createContext({state: {scope:'clipboard'}, scopeOrder:[], scopeRow:root, document:{createElement:createButton}});
vm.runInContext(source.slice(source.indexOf('function renderPluginScopes('), source.indexOf('function pluginEnabled(')), scopes);
const plugins = [{id:'clipboard',name:'剪切板',enabled:true,available:true,searchable:true,order:1}, {id:'app',name:'应用',enabled:true,available:true,searchable:true,order:2}];
scopes.renderPluginScopes(plugins);
const pressed = children[1];
scopes.renderPluginScopes(plugins.map(p => ({...p})));
assert.equal(children[1], pressed); assert(pressed.active); assert(!children[0].active);
scopes.renderPluginScopes(plugins.map(p => ({...p,name:p.id==='clipboard'?'剪贴板':p.name})));
assert.equal(children[1], pressed); assert.equal(pressed.textContent,'剪贴板');
scopes.renderPluginScopes(plugins.filter(p=>p.id==='app'));
assert.equal(scopes.state.scope,'all'); assert(children[0].active); assert.equal(children.length,2);
console.log('PASS: scope mouse press preserves input focus; refresh retains pressed nodes and active scope');
