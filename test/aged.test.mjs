import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agedUses, costEvents, receiptItems } from '../web/items.js';
import { spendByKind } from '../web/analytics.js';

const receipts = [
  { id: 'r1', status: 'read', date: '2026-08-01', vendor: 'MHC', lines: [
    { id: 'a', kind: 'part', text: 'HOSE', qty: 2, price: 60 },
    { id: 'b', kind: 'part', text: 'HEADLAMP', qty: 1, price: 90, to: 'truck', vehicleId: 'v24' },
    { id: 'c', kind: 'part', text: '11R22.5 DRIVE TIRE', qty: 2, price: 800, tire: true },
    { id: 'd', kind: 'part', text: 'BELT', qty: 1, price: 40 },
  ] },
  { id: 'r2', status: 'read', date: '2026-10-20', vendor: 'MHC', lines: [{ id: 'e', kind: 'part', text: 'FILTER', qty: 1, price: 30 }] },
];
const names = new Map([['v24', 'T-24']]);

test('after 90 days: unassigned parts go to the shop, parts bought for a truck to that truck; tires and newer items wait', () => {
  const items = receiptItems(receipts);
  const uses = [
    { receiptId: 'r1', lineId: 'a', qty: 1, logId: 'w', vehicleId: 'v7', status: 'auto' }, // one of the two hoses was used
    { receiptId: 'r1', lineId: 'd', qty: 0, status: 'snooze', until: '2026-12-01' }, // admin: still on the shelf
  ];
  const aged = agedUses({ items, uses, today: '2026-11-25', names });
  assert.deepEqual(aged.map((u) => [u.lineId, u.qty, u.shop, u.vehicleName ?? null, u.by, u.status, u.aged]), [
    ['a', 1, true, null, 'rule', 'auto', true],
    ['b', 1, false, 'T-24', 'rule', 'auto', true],
  ]);
  // Not again once aged.
  assert.deepEqual(agedUses({ items, uses: [...uses, ...aged], today: '2026-11-26', names }), []);
  // The costs: $30 hose to the shop, the $90 headlamp to T-24.
  const events = costEvents({ receipts, uses: [...uses, ...aged], log: [] }).filter((e) => e.aged);
  assert.deepEqual(events.map((e) => [e.kind, e.unitId ?? null, e.amount]), [['supplies', null, 30], ['parts', 'v24', 90]]);
  assert.deepEqual(spendByKind({ events, log: [], from: '2026-08-01', to: '2026-08-31' }).map((k) => [k.key, k.amount]), [['repair', 90], ['shop', 30]]);
});
