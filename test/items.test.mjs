import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accuracy, auditQueue, costEvents, receiptWork, landedCosts, lineKind, oldStock, openItems, receiptItems, remainingQty, ruleUses,
  shopShare, spending, stockLots,
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

test('spending: what each truck used, from its receipts; shop costs apart; what is waiting', () => {
  const uses = [
    { receiptId: 'r1', lineId: 'a', qty: 1, logId: 'e1', vehicleId: 'v7', vehicleName: 'T-07', status: 'confirmed' },
    { receiptId: 'r1', lineId: 'a', qty: 1, logId: 'e3', vehicleId: 'v19', vehicleName: 'T-19', status: 'doubt' },
    { receiptId: 'r1', lineId: 'c', part: 'of5', qty: 1, logId: 'e4', vehicleId: 'v7', vehicleName: 'T-07', status: 'auto', by: 'rule' },
  ];
  const s = spending({ receipts, uses, log, from: '2026-09-01', to: '2026-10-31' });
  // T-07: drum $129.13 + one filter $27 (of 4 for $108). The headlamp bought for T-31 is set aside, not used.
  assert.deepEqual(s.units.map((u) => [u.name, u.total, u.unpriced]), [['T-07', 156.13, 0]]);
  assert.deepEqual(s.shop, { supplies: 20.5, tools: 0, total: 20.5 });
  assert.equal(s.open, 129.13); // the drum still waiting for admin
  assert.equal(s.waiting, 90);
});

// The walkthrough: one FleetPride receipt with parts for T-24, parts for
// T-31 and shop items; T-24 is serviced 2 days later, T-31 a day after that.
const fleetPride = {
  id: 'fp', status: 'read', date: '2026-11-03', vendor: 'FleetPride', note: 'T-24 drum, T-31 headlight',
  lines: [
    { id: 'f', part: 'of-gen5', kind: 'stock', text: 'OIL FILTER A4711800209', qty: 2, price: 94.78, cost: 103.85, to: 'stock' },
    { id: 'd', kind: 'part', text: 'BRAKE DRUM DB1655B', qty: 1, price: 231.62, cost: 253.80, to: 'truck', vehicleId: 'v24' },
    { id: 'h', kind: 'part', text: 'HEADLAMP', qty: 1, price: 90, cost: 98.62, to: 'truck', vehicleId: 'v31' },
    { id: 'c', kind: 'supplies', text: 'BRAKE CLEANER CASE', qty: 1, price: 48, cost: 52.60, to: 'shop' },
    { id: 's', kind: 'tool', text: '1/2 SOCKET SET', qty: 1, price: 60, cost: 65.74, to: 'shop' },
  ],
};
const work = [
  { id: 'e1', date: '2026-11-05', vehicleId: 'v24', vehicleName: 'T-24', services: ['oil'], partsUsed: { 'of-gen5': 1, oil: 11.4 } },
  { id: 'e2', date: '2026-11-05', vehicleId: 'v24', vehicleName: 'T-24', type: 'repair', itemName: 'Se cambió tambor trasero lado chofer' },
  { id: 'e3', date: '2026-11-06', vehicleId: 'v31', vehicleName: 'T-31', services: ['oil'], partsUsed: { 'of-gen5': 1, oil: 11.4 } },
  { id: 'e4', date: '2026-11-06', vehicleId: 'v31', vehicleName: 'T-31', type: 'repair', itemName: 'Luz delantera' },
];

test('walkthrough: the rules take each oil filter from the batch; the oil has no receipt yet', () => {
  assert.deepEqual(stockLots([fleetPride]).map((l) => [l.key, l.qty, l.unitCost]), [['fp:f', 2, 51.925]]);
  const rule = ruleUses({ receipts: [fleetPride], uses: [], log: work });
  assert.deepEqual(rule.map((u) => [u.logId, u.vehicleName, u.part, u.qty, u.by, u.status]), [
    ['e1', 'T-24', 'of-gen5', 1, 'rule', 'auto'],
    ['e3', 'T-31', 'of-gen5', 1, 'rule', 'auto'],
  ]);
  assert.deepEqual(ruleUses({ receipts: [fleetPride], uses: rule, log: work }), []); // nothing left to do
  // The AI ties the drum (sure) and the headlamp (unsure: waits for admin).
  const ai = [
    { receiptId: 'fp', lineId: 'd', qty: 1, logId: 'e2', vehicleId: 'v24', vehicleName: 'T-24', by: 'ai', status: 'auto', confidence: 95 },
    { receiptId: 'fp', lineId: 'h', qty: 1, logId: 'e4', vehicleId: 'v31', vehicleName: 'T-31', by: 'ai', status: 'doubt', confidence: 80 },
  ];
  const before = costEvents({ receipts: [fleetPride], uses: [...rule, ...ai], log: work });
  const truck = (events, id) => events.filter((ev) => ev.unitId === id).map((ev) => [ev.kind, ev.text, ev.amount, ev.receiptId ?? null]);
  assert.deepEqual(truck(before, 'v24'), [
    ['parts', 'of-gen5', 51.93, 'fp'], ['unpriced', 'oil', 0, null], ['parts', 'BRAKE DRUM DB1655B', 253.8, 'fp'],
  ]);
  assert.deepEqual(truck(before, 'v31'), [
    ['parts', 'of-gen5', 51.92, 'fp'], ['unpriced', 'oil', 0, null], ['waiting', 'HEADLAMP', 98.62, 'fp'], // the last filter takes the leftover cent
  ]);
  // Admin confirms the headlamp: now it counts, on the work's date.
  const after = costEvents({ receipts: [fleetPride], uses: [...rule, ai[0], { ...ai[1], status: 'confirmed' }], log: work });
  assert.deepEqual(truck(after, 'v31').at(-1), ['parts', 'HEADLAMP', 98.62, 'fp']);
  assert.deepEqual(after.filter((ev) => !ev.unitId).map((ev) => [ev.kind, ev.amount]), [['supplies', 52.6], ['tools', 65.74]]);
  const s = spending({ receipts: [fleetPride], uses: [...rule, ai[0], { ...ai[1], status: 'confirmed' }], log: work, from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(s.units.map((u) => [u.name, u.total, u.unpriced]), [['T-24', 305.73], ['T-31', 150.54]].map(([n, t]) => [n, t, 1]));
});

test('rules: oldest batch first, across batches; batches set aside for a truck go to it; only batches bought by the work date', () => {
  const drum = (id, date, cost, extra = {}) => ({ id, status: 'read', date, lines: [{ id: 'o', part: 'oil', qty: 55, cost, ...extra }] });
  const receipts2 = [drum('d1', '2026-11-03', 742.5), drum('d2', '2026-11-12', 775.5)];
  const oilChange = (id, date, v, gal = 11.4) => ({ id, date, vehicleId: v, vehicleName: v, partsUsed: { oil: gal } });
  const log2 = [
    oilChange('a', '2026-11-04', 'T-20'), oilChange('b', '2026-11-06', 'T-24'), oilChange('c', '2026-11-09', 'T-07'),
    oilChange('d', '2026-11-11', 'T-25', 2), oilChange('e', '2026-11-14', 'T-31'), oilChange('f', '2026-11-17', 'T-19'),
    oilChange('old', '2026-09-01', 'T-09'), // before any oil was bought here
  ];
  const rule = ruleUses({ receipts: receipts2, uses: [], log: log2 });
  assert.deepEqual(rule.filter((u) => u.logId === 'f').map((u) => [u.receiptId, u.qty]), [['d1', 7.4], ['d2', 4]]);
  assert.equal(rule.some((u) => u.logId === 'old'), false);
  const ev = costEvents({ receipts: receipts2, uses: rule, log: log2 });
  assert.deepEqual(ev.filter((x) => x.logId === 'f').map((x) => x.amount), [99.9, 56.4]); // 7.4 gal at $13.50, 4 at $14.10
  assert.deepEqual(ev.find((x) => x.logId === 'old'), { date: '2026-09-01', kind: 'unpriced', amount: 0, unitId: 'T-09', unitName: 'T-09', assetType: 'truck', text: 'oil', part: 'oil', qty: 11.4, logId: 'old' });
  // A receipt dated the day after the work still covers it; a week after doesn't.
  assert.equal(ruleUses({ receipts: [drum('late', '2026-11-05', 700)], uses: [], log: [oilChange('x', '2026-11-04', 'T-20')] }).length, 1);
  assert.equal(ruleUses({ receipts: [drum('late', '2026-11-11', 700)], uses: [], log: [oilChange('x', '2026-11-04', 'T-20')] }).length, 0);
  // One filter set aside for T-31 and one not: T-24 gets the free one even though T-31's is older.
  const set = { id: 'p', status: 'read', date: '2026-11-01', lines: [{ id: 'x', part: 'f', qty: 1, cost: 50, for: [{ id: 'v31', name: 'T-31' }] }] };
  const free = { id: 'q', status: 'read', date: '2026-11-02', lines: [{ id: 'y', part: 'f', qty: 1, cost: 55 }] };
  assert.deepEqual(ruleUses({ receipts: [set, free], uses: [], log: [{ id: 'w', date: '2026-11-03', vehicleId: 'v24', partsUsed: { f: 1 } }] }).map((u) => u.receiptId), ['q']);
});

test('old stock shows for review; big tools spread over 12 months; shop share by visits', () => {
  const lot = { id: 'r', status: 'read', date: '2026-08-01', lines: [{ id: 'a', part: 'of5', qty: 3, cost: 90 }] };
  assert.deepEqual(oldStock([lot], [{ receiptId: 'r', lineId: 'a', qty: 1, status: 'auto' }], '2026-10-27').map((l) => [l.key, l.remaining]), [['r:a', 2]]);
  assert.deepEqual(oldStock([lot], [], '2026-09-15'), []); // under 60 days
  const scanner = { id: 't', status: 'read', date: '2026-01-31', lines: [{ id: 'x', kind: 'tool', text: 'SCANNER', qty: 1, cost: 1200 }] };
  const months = costEvents({ receipts: [scanner], uses: [], log: [] });
  assert.deepEqual([months.length, months[0].amount, months[1].date, months.at(-1).date, months.reduce((s, e) => s + e.amount, 0)], [12, 100, '2026-02-28', '2026-12-31', 1200]);
  const visits = [
    { vehicleId: 'v24', date: '2026-11-05', services: ['x'] }, { vehicleId: 'v24', date: '2026-11-05', type: 'repair' }, // one visit
    { vehicleId: 'v31', date: '2026-11-06', services: ['x'] }, { vehicleId: 'v07', date: '2026-11-09', type: 'repair' },
  ];
  const share = shopShare({ unitId: 'v24', periods: [{ key: 'nov', from: '2026-11-01', to: '2026-11-30' }], events: [{ date: '2026-11-03', kind: 'supplies', amount: 52.6 }, { date: '2026-11-03', kind: 'tools', amount: 65.74 }], log: visits });
  assert.deepEqual([share[0].visits, share[0].allVisits, share[0].share], [1, 3, 39.45]);
});

test('the work a receipt went into: its repairs, earliest first, unsure ones marked', () => {
  const uses = [
    { receiptId: 'r1', lineId: 'a', qty: 1, logId: 'e1', status: 'confirmed' },
    { receiptId: 'r1', lineId: 'a', qty: 1, logId: 'e3', status: 'doubt' },
    { receiptId: 'r1', lineId: 'b', qty: 1, logId: 'e1', status: 'auto' },
    { receiptId: 'r1', lineId: 'a', qty: 1, logId: 'e2', status: 'rejected' },
    { receiptId: 'r2', lineId: 'i0', qty: 1, logId: 'e2', status: 'auto' },
  ];
  assert.deepEqual(receiptWork(receipts[0], uses, log).map((w) => [w.date, w.vehicleName, w.text, w.sure]), [
    ['2026-10-19', 'T-07', 'Disco delantero copiloto se remplazo', true],
    ['2026-10-25', 'T-19', 'Ajuste de frenos', false],
  ]);
  assert.deepEqual(receiptWork(receipts[3], uses, log), []);
});
