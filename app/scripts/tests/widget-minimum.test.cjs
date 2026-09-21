const { test } = require('node:test');
const assert = require('node:assert/strict');

test('plugin minimum sizing preserves generic defaults and bounds manifest input', async () => {
  const { minimum } = await import('../../src/canvas/model.ts');
  const sources = [
    { id: 'machine', widget: { minWidth: 220, minHeight: 150 } },
    { id: 'docker', widget: { interactive: true } },
    { id: 'bad', widget: { minWidth: 99999, minHeight: -1 } },
    { id: 'tall', widget: { minWidth: -10, minHeight: 99999 } },
    { id: 'invalid', widget: { minWidth: 'NaN', minHeight: 'NaN' } },
  ];
  const size = plugin => minimum({ plugin }, sources);
  assert.deepEqual(size('machine'), { width: 220, height: 150 });
  assert.deepEqual(size('other'), { width: 160, height: 120 });
  assert.deepEqual(size('docker'), { width: 320, height: 280 });
  assert.deepEqual(size('bad'), { width: 1600, height: 120 });
  assert.deepEqual(size('tall'), { width: 160, height: 1200 });
  assert.deepEqual(size('invalid'), { width: 160, height: 120 });
});
