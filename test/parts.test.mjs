import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  averageCost, kitKey, kitParts, onHand, packsFor, shoppingList, tagsForJobs, tagsForKeys, tireParts,
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
  { id: 'oil', group: 'oil', min: 10, packs: [{ name: 'Drum', size: 55 }, { name: 'Case', size: 6 }] },
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

test('the DD15 GHG17 schedule splits its kits at 2021 builds (Gen 5 filters)', () => {
  const s = new Map([['detroit-dd15-ghg17-longhaul', { category: 'engine', items: [] }]]);
  const v = (year) => ({ year, scheduleIds: ['detroit-dd15-ghg17-longhaul'] });
  assert.equal(kitKey(v(2019), 'oil', s), 'detroit-dd15-ghg17-longhaul');
  assert.equal(kitKey(v(2021), 'fuelFilters', s), 'detroit-dd15-ghg17-longhaul@2021');
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
  const byId = Object.fromEntries(list.map((x) => [x.part.id, x]));
  assert.equal(byId.oil.buy, 6); // 11 needed + 10 minimum - 15 on hand
  assert.deepEqual(byId.oil.packs, [{ name: 'Drum', size: 55, count: 1 }, { name: 'Case', size: 6, count: 1 }]);
  assert.equal(byId.of, undefined); // 1 + 2 minimum <= 4 on hand
  assert.equal(byId.ff.buy, 1);
  assert.equal(byId.steer, undefined);
});

test('packs round up and average cost uses priced lines', () => {
  assert.deepEqual(packsFor({ packs: [{ name: 'Case', size: 6 }] }, 13), [{ name: 'Case', size: 6, count: 3 }]);
  const receipts = [{ lines: [{ part: 'of', qty: 2, price: 50 }, { part: 'of', qty: 2, price: 70 }, { part: 'of', qty: 5 }] }];
  assert.equal(averageCost('of', receipts), 30);
});
