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
