import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accuracy, auditQueue, landedCosts, lineKind, openItems, receiptItems, remainingQty, spending,
} from '../web/items.js';

const receipts = [
  {
    id: 'r1', status: 'read', date: '2026-10-21', vendor: 'MHC', note: null,
    lines: [
      { id: 'a', kind: 'part', text: 'DRUM-BRAKE', partNumber: 'DB1655B', qty: 2, price: 231.62, cost: 258.25, to: null },
      { id: 'b', kind: 'supplies', text: 'BRAKE CLEANER', qty: 1, price: 8, cost: 8.5, to: 'shop' },
      { id: 'c', part: 'of5', kind: 'stock', text: 'OIL FILTER', qty: 4, price: 100, cost: 108, to: 'stock' },
    ],
  },
  { id: 'r2', status: 'read', date: '2026-09-01', vendor: 'FleetPride', lines: [{ kind: 'part', text: 'HEADLAMP', qty: 1, price: 90, to: 'truck', vehicleId: 'v31' }] },
  { id: 'r3', status: 'waiting', date: '2026-10-25', lines: [] },
  { id: 'r4', status: 'read', date: '2026-10-22', vendor: 'Doggett', lines: [{ id: 'd', to: 'shop', text: 'RAGS', qty: 1, price: 12 }] },
];
const items = receiptItems(receipts);
const log = [
  { id: 'e1', type: 'repair', date: '2026-10-19', vehicleId: 'v7', vehicleName: 'T-07', itemName: 'Disco delantero copiloto se remplazo' },
  { id: 'e2', type: 'repair', date: '2026-10-05', vehicleId: 'v19', vehicleName: 'T-19', itemName: 'Headlight passenger side replace' },
  { id: 'e3', type: 'repair', date: '2026-10-25', vehicleId: 'v19', vehicleName: 'T-19', itemName: 'Ajuste de frenos' },
  { id: 'e4', date: '2026-10-20', vehicleId: 'v7', vehicleName: 'T-07', services: ['x'], partsUsed: { of5: 1 } },
];
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

test('real cost: tax and fees split by price, adding up to the cent', () => {
  assert.deepEqual(landedCosts([{ price: 231.62 }], 26.63), [258.25]);
  assert.deepEqual(landedCosts([{ price: 1 }, { price: 1 }, { price: 1 }], 1), [1.34, 1.33, 1.33]);
  assert.deepEqual(landedCosts([{ price: 50 }, { price: null }, { price: -5 }], 5), [55, null, -5]);
});

test('receipt lines become items (not stock, not unread receipts), with kinds for older lines', () => {
  assert.deepEqual(items.map((it) => [it.key, it.kind, it.qty, it.unitCost, it.vehicleId]), [
    ['r1:a', 'part', 2, 129.125, null],
    ['r1:b', 'supplies', 1, 8.5, null],
    ['r2:i0', 'part', 1, 90, 'v31'],
    ['r4:d', 'supplies', 1, 12, null],
  ]);
  assert.equal(lineKind({ to: 'shop' }), 'supplies');
  assert.equal(lineKind({ part: 'x' }), 'stock');
});

test('open items: pool kinds with something left, recent, not snoozed', () => {
  const uses = [{ receiptId: 'r1', lineId: 'a', qty: 1, status: 'auto' }, { receiptId: 'r1', lineId: 'a', qty: 1, status: 'rejected' }];
  const open = openItems(items, uses, { today: '2026-10-27' });
  assert.deepEqual(open.map((it) => [it.key, it.remaining]), [['r1:a', 1], ['r2:i0', 1]]);
  assert.equal(remainingQty(items[0], uses), 1);
  const snoozed = openItems(items, [{ receiptId: 'r2', lineId: 'i0', qty: 0, status: 'snooze', until: '2026-11-20' }], { today: '2026-10-27' });
  assert.deepEqual(snoozed.map((it) => it.key), ['r1:a']);
  assert.deepEqual(openItems(items, [], { today: '2026-10-27', days: 30 }).map((it) => it.key), ['r1:a']);
});

test('the admin queue: doubts, recent automatic matches, bought with no work, repairs with no parts', () => {
  const uses = [
    { id: 'u1', receiptId: 'r1', lineId: 'a', qty: 2, logId: 'e1', status: 'doubt', by: 'ai', createdAt: ts('2026-10-26T10:00:00Z') },
    { id: 'u2', receiptId: 'r2', lineId: 'i0', qty: 1, logId: 'e2', status: 'auto', by: 'ai', createdAt: ts('2026-10-01T10:00:00Z') },
  ];
  const q = auditQueue({ items, uses, log, today: '2026-10-27' });
  assert.deepEqual(q.doubts.map((x) => [x.use.id, x.item.key, x.entry.id]), [['u1', 'r1:a', 'e1']]);
  assert.deepEqual(q.recent, []); // u2 is older than 2 weeks
  assert.deepEqual(q.noWork, []);
  assert.deepEqual(q.noParts.map((e) => e.id), []); // e1, e2 have parts; e3 is under a week old
  const empty = auditQueue({ items, uses: [], log, today: '2026-11-10' });
  assert.deepEqual(empty.noWork.map((it) => it.key), ['r2:i0', 'r1:a']); // oldest first; the headlamp was bought for T-31 but no repair says so
  assert.deepEqual(empty.noParts.map((e) => e.id), ['e3', 'e1', 'e2']);
  const done = auditQueue({ items, uses: [], log: log.map((e) => ({ ...e, noParts: e.id === 'e3' })), today: '2026-11-10' });
  assert.deepEqual(done.noParts.map((e) => e.id), ['e1', 'e2']);
});

test('accuracy counts what admin checked', () => {
  const at = ts('2026-10-10T00:00:00Z');
  const uses = [
    { by: 'ai', status: 'confirmed', createdAt: at }, { by: 'ai', status: 'confirmed', createdAt: at },
    { by: 'ai', status: 'rejected', createdAt: at }, { by: 'ai', status: 'auto', createdAt: at },
    { by: 'admin', status: 'confirmed', createdAt: at }, { by: 'ai', status: 'confirmed', createdAt: ts('2026-09-10T00:00:00Z') },
  ];
  assert.deepEqual(accuracy(uses, '2026-10'), { made: 4, checked: 3, right: 2, unchecked: 1 });
});

test('spending: shelf parts at real cost, matched items on the work date, truck-bought items, shop supplies', () => {
  const uses = [
    { receiptId: 'r1', lineId: 'a', qty: 1, logId: 'e1', vehicleId: 'v7', vehicleName: 'T-07', status: 'confirmed' },
    { receiptId: 'r1', lineId: 'a', qty: 1, logId: 'e3', vehicleId: 'v19', vehicleName: 'T-19', status: 'doubt' },
  ];
  const s = spending({ receipts, uses, log, parts: [], from: '2026-09-01', to: '2026-10-31' });
  assert.deepEqual(s.units.map((u) => [u.name, u.shelf, u.items, u.total]), [['T-07', 27, 129.13, 156.13], ['v31', 0, 90, 90]]);
  assert.deepEqual(s.shop, { supplies: 20.5, tools: 0, total: 20.5 });
  assert.equal(s.open, 129.13); // the drum still waiting for admin
});
