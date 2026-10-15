import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleDocs } from '../scripts/schedules.mjs';
import { hasSpanish, itemName } from '../web/item-names.js';

test('every schedule item has a Spanish name', () => {
  const missing = [...new Set(scheduleDocs().flatMap((s) => s.items.map((i) => i.name)))].filter((n) => !hasSpanish(n));
  assert.deepEqual(missing, []);
});

test('English stays English; unknown names pass through', () => {
  assert.equal(itemName('Engine oil & oil filter', 'en'), 'Engine oil & oil filter');
  assert.equal(itemName('Engine oil & oil filter', 'es'), 'Aceite y filtro de motor');
  assert.equal(itemName('Something new', 'es'), 'Something new');
});
