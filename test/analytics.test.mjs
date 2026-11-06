import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fleetBreakdown, milesIn, monthPeriods, periodsFor, pieSlices, spendByKind, trendMonths, unitBreakdown, unmatchedItems, weekPeriods, workKind,
} from '../web/analytics.js';

test('months and weeks touching a range, cut to it', () => {
  assert.deepEqual(monthPeriods('2026-08-15', '2026-10-27'), [
    { key: '2026-08', label: 'Aug', from: '2026-08-15', to: '2026-08-31' },
    { key: '2026-09', label: 'Sep', from: '2026-09-01', to: '2026-09-30' },
    { key: '2026-10', label: 'Oct', from: '2026-10-01', to: '2026-10-27' },
  ]);
  assert.deepEqual(monthPeriods('2025-12-01', '2026-01-31').map((p) => p.label), ['Dec', "Jan '26"]);
  // Oct 1, 2026 is a Thursday: the first week is Oct 1-4 (cut), then Monday weeks.
  assert.deepEqual(weekPeriods('2026-10-01', '2026-10-12'), [
    { key: '2026-10-01', label: 'Oct 1', from: '2026-10-01', to: '2026-10-04' },
    { key: '2026-10-05', label: 'Oct 5', from: '2026-10-05', to: '2026-10-11' },
    { key: '2026-10-12', label: 'Oct 12', from: '2026-10-12', to: '2026-10-12' },
  ]);
});

test('the date choices: month by week, year by month, range by size, all since the first record', () => {
  const today = '2026-10-27';
  const month = periodsFor({ mode: 'month', month: '2026-10' }, today);
  assert.deepEqual([month.grain, month.from, month.to, month.periods.length, month.periods.at(-1).to], ['week', '2026-10-01', '2026-10-27', 5, '2026-10-27']);
  assert.deepEqual(periodsFor({ mode: 'month', month: '2026-09' }, today).periods.map((p) => p.key), ['2026-09-01', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  const year = periodsFor({ mode: 'year', year: '2026' }, today);
  assert.deepEqual([year.grain, year.periods.length, year.periods[0].key, year.to], ['month', 10, '2026-01', today]);
  assert.equal(periodsFor({ mode: 'year', year: '2025' }, today).periods.length, 12);
  assert.equal(periodsFor({ mode: 'range', from: '2026-10-01', to: '2026-09-01' }, today).grain, 'week'); // swapped dates still work
  assert.equal(periodsFor({ mode: 'range', from: '2026-01-01', to: '2026-10-01' }, today).grain, 'month');
  const all = periodsFor({ mode: 'all' }, today, '2026-02-14');
  assert.deepEqual([all.from, all.periods.length], ['2026-02-01', 9]);
  assert.deepEqual(periodsFor({ mode: 'month', month: '2026-12' }, today).periods, []);
});

test('work kinds; duty changes are not work', () => {
  assert.deepEqual([{ type: 'repair' }, { type: 'tires' }, { tires: ['S1L'] }, { type: 'batteries' }, { services: ['x'] }, { type: 'duty' }].map(workKind),
    ['repair', 'tires', 'tires', 'batteries', 'service', null]);
});

test('miles in a period come from the odometer readings around it', () => {
  const days = { '2026-09-28': { miles: 1000 }, '2026-10-02': { miles: 1500 }, '2026-10-30': { miles: 4000 }, '2026-11-01': { miles: 4200 } };
  assert.equal(milesIn(days, '2026-10-01', '2026-10-31'), 3000);
  assert.equal(milesIn(days, '2026-09-01', '2026-09-30'), 0); // only one reading in it
  assert.equal(milesIn({ '2026-10-05': { miles: 10 }, '2026-10-20': { miles: 510 } }, '2026-10-01', '2026-10-31'), 500);
  assert.equal(milesIn(days, '2026-07-01', '2026-07-31'), null);
  assert.equal(milesIn(null, '2026-10-01', '2026-10-31'), null);
});

test('one truck period by period: work counts, shelf and repair spend, cost per mile', () => {
  const periods = monthPeriods('2026-09-01', '2026-10-27');
  const events = [
    { date: '2026-10-19', kind: 'parts', amount: 258.25, unitId: 'v7' },
    { date: '2026-10-20', kind: 'parts', amount: 120, unitId: 'v7' },
    { date: '2026-10-20', kind: 'unpriced', amount: 0, unitId: 'v7' },
    { date: '2026-09-10', kind: 'parts', amount: 80, unitId: 'v7' },
    { date: '2026-10-05', kind: 'parts', amount: 999, unitId: 'v19' },
    { date: '2026-10-06', kind: 'supplies', amount: 9, unitId: null },
    { date: '2026-10-07', kind: 'waiting', amount: 50, unitId: 'v7' }, // set aside, not used: not a cost
  ];
  const log = [
    { vehicleId: 'v7', date: '2026-10-19', type: 'repair' },
    { vehicleId: 'v7', date: '2026-10-20', services: ['x'] },
    { vehicleId: 'v7', date: '2026-10-21', type: 'duty' },
    { vehicleId: 'v7', date: '2026-09-10', type: 'tires' },
  ];
  const days = { '2026-08-31': { miles: 10000 }, '2026-09-30': { miles: 18000 }, '2026-10-27': { miles: 24000 } };
  const { rows, totals } = unitBreakdown({ unitId: 'v7', periods, events, log, days });
  assert.deepEqual(rows.map((r) => [r.key, r.miles, r.service, r.repair, r.tires, r.parts, r.unpriced, r.total, r.perMile]), [
    ['2026-09', 8000, 0, 0, 1, 80, 0, 80, 0.01],
    ['2026-10', 6000, 1, 1, 0, 378.25, 1, 378.25, 0.06],
  ]);
  assert.deepEqual([totals.miles, totals.total, totals.perMile, totals.repair, totals.unpriced], [14000, 458.25, 0.03, 1, 1]);
  const trailer = unitBreakdown({ unitId: 'v7', periods, events, log });
  assert.deepEqual([trailer.rows[1].miles, trailer.rows[1].perMile, trailer.totals.miles], [null, null, null]);
});

test('the whole fleet: every unit and the shop add up; units ranked by spend', () => {
  const periods = monthPeriods('2026-09-01', '2026-10-27');
  const units = [{ id: 'v7', name: 'T-07', trailer: false }, { id: 'v19', name: 'T-19', trailer: false }, { id: 'c1', name: '501', trailer: true }, { id: 'v9', name: 'T-09', trailer: false }];
  const events = [
    { date: '2026-10-19', kind: 'parts', amount: 258.25, unitId: 'v7' },
    { date: '2026-09-10', kind: 'parts', amount: 80, unitId: 'v7' },
    { date: '2026-10-05', kind: 'parts', amount: 999, unitId: 'v19' },
    { date: '2026-10-06', kind: 'parts', amount: 40, unitId: 'c1' },
    { date: '2026-10-07', kind: 'parts', amount: 10, unitId: 'gone' }, // a unit since removed
    { date: '2026-10-06', kind: 'supplies', amount: 9, unitId: null },
    { date: '2026-09-02', kind: 'tools', amount: 60, unitId: null },
    { date: '2026-10-08', kind: 'open', amount: 500, unitId: null }, // not tied to anything yet: not counted
  ];
  const log = [
    { vehicleId: 'v7', date: '2026-10-19', type: 'repair' },
    { vehicleId: 'v19', date: '2026-10-05', type: 'repair' },
    { vehicleId: 'c1', date: '2026-10-06', type: 'tires' },
    { vehicleId: 'v9', date: '2026-10-09', services: ['x'] },
  ];
  const daysById = {
    v7: { '2026-08-31': { miles: 10000 }, '2026-09-30': { miles: 18000 }, '2026-10-27': { miles: 24000 } },
    v19: { '2026-09-30': { miles: 50000 }, '2026-10-27': { miles: 54000 } },
  };
  const { rows, totals, byUnit } = fleetBreakdown({ units, periods, events, log, daysById });
  assert.deepEqual(rows.map((r) => [r.key, r.miles, r.parts, r.shop, r.total, r.repair, r.tires, r.service]), [
    ['2026-09', 8000, 80, 60, 140, 0, 0, 0],
    ['2026-10', 10000, 1307.25, 9, 1316.25, 2, 1, 1],
  ]);
  assert.deepEqual(rows[1].units.map((u) => [u.name, u.total]), [['T-19', 999], ['T-07', 258.25], ['501', 40]]);
  assert.deepEqual([totals.miles, totals.total, totals.shop, totals.perMile, totals.reporting], [18000, 1456.25, 69, 0.08, 2]);
  assert.deepEqual(byUnit.map((u) => [u.name, u.total, u.work, u.miles]), [['T-19', 999, 1, 4000], ['T-07', 338.25, 1, 14000], ['501', 40, 1, null], ['T-09', 0, 1, null]]);
});

test('dashboard: the trend is months; a month or a short range shows the 12 months up to it', () => {
  const year = periodsFor({ mode: 'year', year: '2026' }, '2026-11-06');
  assert.equal(trendMonths({ ...year, to: year.to }).length, 11);
  const month = periodsFor({ mode: 'month', month: '2026-10' }, '2026-11-06');
  const t = trendMonths(month);
  assert.deepEqual([t.length, t[0].from, t.at(-1).to], [12, '2025-11-01', '2026-10-31']);
});

test('dashboard: spending by what it went to, the shop\'s only fleet-wide and when included', () => {
  // Maintenance is work that reset a schedule item; a tire change that didn't is a repair.
  const log = [{ id: 'r', type: 'repair', date: '2026-10-02' }, { id: 's', type: 'service', date: '2026-10-03', services: ['pm__oil'] }, { id: 't', type: 'tires', date: '2026-10-03' }];
  const events = [
    { kind: 'parts', unitId: 'v1', date: '2026-10-02', amount: 100, logId: 'r' },
    { kind: 'parts', unitId: 'v2', date: '2026-10-03', amount: 60, logId: 's' },
    { kind: 'parts', unitId: 'v1', date: '2026-10-04', amount: 85.5, paperwork: true },
    { kind: 'parts', unitId: 'v1', date: '2026-10-05', amount: 20 },
    { kind: 'parts', unitId: 'v2', date: '2026-10-03', amount: 10, logId: 't' },
    { kind: 'supplies', unitId: null, date: '2026-10-05', amount: 40 },
    { kind: 'tools', unitId: null, date: '2026-10-05', amount: 300 },
    { kind: 'open', unitId: null, date: '2026-10-05', amount: 999 },
    { kind: 'parts', unitId: 'v1', date: '2026-09-30', amount: 500, logId: 'r' },
  ];
  const range = { events, log, from: '2026-10-01', to: '2026-10-31' };
  assert.deepEqual(spendByKind(range).map((x) => [x.label, x.amount]), [['Parts on hand', 999], ['Shop supplies', 340], ['Repairs', 130], ['Inspection & registrations', 85.5], ['Maintenance', 60]]);
  assert.deepEqual(spendByKind({ ...range, includeShop: false }).map((x) => x.key), ['onhand', 'repair', 'paperwork', 'maintenance']);
  assert.deepEqual(spendByKind({ ...range, unitId: 'v1' }).map((x) => [x.key, x.amount]), [['repair', 120], ['paperwork', 85.5]]);
  const open = unmatchedItems(events, '2026-10-01', '2026-10-31');
  assert.deepEqual([open.total, open.count], [999, 1]);
});

test('dashboard: pie keeps the biggest, folds the rest, and always shows the pinned slice', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, label: `T-${i}`, amount: 100 - i }));
  const slices = pieSlices(items, { max: 8, pinned: [{ id: 'shop', label: 'Fleet-wide', amount: 50 }] });
  assert.deepEqual(slices.map((s) => s.id), ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'other', 'shop']);
  assert.equal(slices[6].amount, 94 + 93 + 92 + 91);
  assert.equal(pieSlices(items.slice(0, 3), { pinned: [{ id: 'shop', amount: 0 }] }).length, 3);
});

test('fleet totals can leave the fleet-wide costs out', () => {
  const periods = monthPeriods('2026-10-01', '2026-10-31');
  const events = [{ kind: 'parts', unitId: 'v1', date: '2026-10-02', amount: 100 }, { kind: 'supplies', unitId: null, date: '2026-10-05', amount: 40 }];
  const units = [{ id: 'v1', name: 'T-01', trailer: false }];
  assert.equal(fleetBreakdown({ units, periods, events, log: [] }).totals.total, 140);
  const without = fleetBreakdown({ units, periods, events, log: [], includeShop: false }).totals;
  assert.deepEqual([without.total, without.shop], [100, 40]);
});
