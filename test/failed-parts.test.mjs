import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditQueue, costEvents, receiptItems } from '../web/items.js';
import { spendByKind } from '../web/analytics.js';

// Two radiators: the first failed, the second went in.
const receipts = [
  { id: 'r1', status: 'read', date: '2026-11-01', vendor: 'Doggett Freightliner', lines: [{ id: 'a', kind: 'part', text: 'RADIATOR', qty: 1, price: 1400 }] },
  { id: 'r2', status: 'read', date: '2026-11-05', vendor: 'Doggett Freightliner', lines: [{ id: 'b', kind: 'part', text: 'RADIATOR', qty: 1, price: 1400 }] },
];
const log = [{ id: 'w', type: 'repair', date: '2026-11-06', vehicleId: 'v27', vehicleName: 'T-27', itemName: 'Cambio de radiador' }];
const second = { receiptId: 'r2', lineId: 'b', logId: 'w', vehicleId: 'v27', qty: 1, status: 'confirmed', by: 'admin' };
const range = { log, from: '2026-11-01', to: '2026-11-30' };

test('defective, not returned: the truck pays for both parts on that repair', () => {
  const uses = [second, { receiptId: 'r1', lineId: 'a', logId: 'w', vehicleId: 'v27', qty: 1, status: 'confirmed', by: 'admin', failed: 'defective' }];
  const events = costEvents({ receipts, uses, log });
  assert.deepEqual(events.map((e) => [e.unitId, e.amount, e.failed ?? null]), [['v27', 1400, 'defective'], ['v27', 1400, null]]);
  assert.deepEqual(spendByKind({ events, ...range }).map((k) => [k.key, k.amount]), [['repair', 2800]]);
});

test('broken during install: a shop loss; returned for credit: shop supplies until the credit cancels it', () => {
  const loss = costEvents({ receipts, uses: [second, { receiptId: 'r1', lineId: 'a', qty: 1, shop: true, status: 'confirmed', by: 'admin', failed: 'misinstalled', failedOn: '2026-11-06' }], log });
  assert.deepEqual(spendByKind({ events: loss, ...range }).map((k) => [k.key, k.amount]), [['repair', 1400], ['losses', 1400]]);
  assert.equal(spendByKind({ events: loss, ...range })[1].label, 'Shop losses');
  const credit = { id: 'r3', status: 'read', date: '2026-11-20', vendor: 'Doggett Freightliner', lines: [{ id: 'c', kind: 'credit', text: 'RETURN RADIATOR', qty: 1, price: -1400 }] };
  const returned = costEvents({ receipts: [...receipts, credit], uses: [second, { receiptId: 'r1', lineId: 'a', qty: 1, shop: true, status: 'confirmed', by: 'admin', failed: 'returned' }], log });
  assert.deepEqual(spendByKind({ events: returned, ...range }).map((k) => [k.key, k.amount]), [['repair', 1400]]);
});

test('a return with no credit after 30 days comes back to review; a credit or "credit came" clears it', () => {
  const returnedUse = { receiptId: 'r1', lineId: 'a', qty: 1, shop: true, status: 'confirmed', by: 'admin', failed: 'returned', createdAt: '2026-11-06T12:00:00Z' };
  const q = (extraReceipts, use, today) => auditQueue({ items: receiptItems([...receipts, ...extraReceipts]), uses: [second, use], log, today }).noCredit;
  assert.equal(q([], returnedUse, '2026-11-20').length, 0); // not 30 days yet
  assert.equal(q([], returnedUse, '2026-12-10').length, 1);
  const credit = { id: 'r3', status: 'read', date: '2026-11-20', vendor: 'Doggett Freightliner of South Texas', lines: [{ id: 'c', kind: 'credit', text: 'RETURN', qty: 1, price: -1400 }] };
  assert.equal(q([credit], returnedUse, '2026-12-10').length, 0);
  assert.equal(q([], { ...returnedUse, creditSeen: true }, '2026-12-10').length, 0);
});
