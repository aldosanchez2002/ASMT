import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  averageCost, kitKey, kitParts, onHand, packsFor, receiptLinesFor, shoppingList, tagsForJobs, tagsForKeys, tireParts,
  upcomingWork,
} from '../web/parts.js';

const schedules = new Map([
  ['dd15', { category: 'engine', items: [{ id: 'oil' }, { id: 'fuel-filter-engine' }] }],
  ['t680', { category: 'chassis', items: [{ id: 'air-filter' }, { id: 'pm-15k' }] }],
]);
const truck = { id: 't1', name: 'T-01', scheduleIds: ['dd15', 't680'] };
const kits = {
  dd15: { oil: [{ part: 'oil', qty: 11 }, { part: 'of', qty: 1 }], fuelFilters: [{ part: 'ff', qty: 1 }, { part: 'pf', qty: 1 }] },
  t680: { airFilter: [{ part: 'af', qty: 1 }] },
};
const parts = [
  { id: 'oil', group: 'oil', unit: 'gal', min: 10, packs: [{ name: 'Drum', size: 55 }, { name: 'Case', size: 6 }] },
  { id: 'of', group: 'filter', min: 2 },
  { id: 'ff', group: 'filter' },
  { id: 'pf', group: 'filter' },
  { id: 'af', group: 'filter' },
  { id: 'steer', group: 'tire', autoUse: 'steerTire' },
  { id: 'drive', group: 'tire', autoUse: 'driveTire' },
];

test('engine tags use the engine kit, the rest the chassis kit', () => {
  assert.equal(kitKey(truck, 'oil', schedules), 'dd15');
  assert.equal(kitKey(truck, 'airFilter', schedules), 't680');
});

test('item keys and jobs map to service tags', () => {
  assert.deepEqual(tagsForKeys(['dd15__oil', 'dd15__fuel-filter-engine']), ['oil', 'fuelFilters']);
  assert.deepEqual(tagsForJobs(['oilChange', 'airFilter']), ['oil', 'fuelFilters', 'airFilter']);
});

test('kit parts add up, and tags without a kit are reported', () => {
  const r = kitParts(truck, ['oil', 'fuelFilters', 'airFilter', 'airDryer', 'chassisPm'], kits, schedules);
  assert.deepEqual(r.parts, { oil: 11, of: 1, ff: 1, pf: 1, af: 1 });
  assert.deepEqual(r.missing, ['airDryer']);
});

test('tires use the steer or drive part by position', () => {
  assert.deepEqual(tireParts(['SL', 'SR', '1LO'], parts), { steer: 2, drive: 1 });
});

test('stock: last count, plus receipts, minus work, only after the count', () => {
  const part = { id: 'of', countQty: 5, countAt: 1000 };
  const receipts = [
    { createdMs: 900, lines: [{ part: 'of', qty: 12 }] }, // before the count: already counted
    { createdMs: 2000, lines: [{ part: 'of', qty: 6 }, { part: 'ff', qty: 3 }] },
  ];
  const log = [
    { loggedAtMs: 500, partsUsed: { of: 1 } },
    { loggedAtMs: 3000, partsUsed: { of: 2 } },
  ];
  assert.equal(onHand(part, receipts, log), 9);
  // Never counted: starts at 0 when the part was added.
  assert.equal(onHand({ id: 'ff', createdAt: '1970-01-01T00:00:01.500Z' }, receipts, log), 3);
});

test('upcoming work and the shopping list', () => {
  const trucks = [
    { ...truck, rows: [{ key: 'dd15__oil', status: 'overdue' }, { key: 'dd15__fuel-filter-engine', status: 'soon' }], wornTires: ['SL'] },
    { ...truck, id: 't2', name: 'T-02', rows: [{ key: 'dd15__oil', status: 'ok' }], wornTires: [] },
  ];
  const work = upcomingWork(trucks, [], kits, schedules, parts);
  assert.equal(work.length, 2);
  assert.deepEqual(work[0].parts, { oil: 11, of: 1, ff: 1, pf: 1 });
  assert.deepEqual(work[1].parts, { steer: 1 });
  const list = shoppingList(parts, work, { oil: 15, of: 4, ff: 0, steer: 3 });
  // Oil filter and steer tire come off the shelf; fuel filters are bought
  // for T-01; oil is one bulk line: 11 needed + 10 minimum - 15 on hand.
  assert.deepEqual(list.map((x) => [x.kind, x.part.id, x.qty, x.unitName]), [
    ['unit', 'ff', 1, 'T-01'], ['unit', 'pf', 1, 'T-01'], ['bulk', 'oil', 6, undefined],
  ]);
  assert.deepEqual(list[2].packs, [{ name: 'Drum', size: 55, count: 1 }, { name: 'Case', size: 6, count: 1 }]);
});

test('the shelf goes to the most urgent truck first; the minimum is restocked', () => {
  const p = [{ id: 'of', min: 2 }];
  const work = [
    { unitId: 'a', unitName: 'T-01', parts: { of: 1 } },
    { unitId: 'b', unitName: 'T-02', parts: { of: 1 } },
  ];
  assert.deepEqual(shoppingList(p, work, { of: 1 }).map((x) => [x.kind, x.unitName ?? null, x.qty]), [
    ['unit', 'T-02', 1], ['restock', null, 2],
  ]);
});

test('lines ticked as bought make one receipt: one line per part, the trucks noted', () => {
  const of = { id: 'of' };
  const oil = { id: 'oil', unit: 'gal', packs: [{ name: 'Drum', size: 55 }] };
  const lines = [
    { kind: 'unit', part: of, qty: 1, unitId: 'a', unitName: 'T-02' },
    { kind: 'unit', part: of, qty: 1, unitId: 'b', unitName: 'T-28' },
    { kind: 'restock', part: of, qty: 2 },
    { kind: 'bulk', part: oil, qty: 89 },
  ];
  assert.deepEqual(receiptLinesFor(lines), [
    { part: 'of', qty: 4, packSize: 1, packQty: 4, to: 'stock', for: [{ id: 'a', name: 'T-02' }, { id: 'b', name: 'T-28' }] },
    { part: 'oil', qty: 110, packSize: 55, packQty: 2, to: 'stock', for: [] },
  ]);
});

test('packs round up and average cost uses priced lines', () => {
  assert.deepEqual(packsFor({ packs: [{ name: 'Case', size: 6 }] }, 13), [{ name: 'Case', size: 6, count: 3 }]);
  const receipts = [{ lines: [{ part: 'of', qty: 2, price: 50 }, { part: 'of', qty: 2, price: 70 }, { part: 'of', qty: 5 }] }];
  assert.equal(averageCost('of', receipts), 30);
});
