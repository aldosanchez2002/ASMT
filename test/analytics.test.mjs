import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fleetBreakdown, milesIn, monthPeriods, periodsFor, unitBreakdown, weekPeriods, workKind,
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
    { date: '2026-10-19', kind: 'items', amount: 258.25, unitId: 'v7' },
    { date: '2026-10-20', kind: 'shelf', amount: 120, unitId: 'v7' },
    { date: '2026-09-10', kind: 'shelf', amount: 80, unitId: 'v7' },
    { date: '2026-10-05', kind: 'items', amount: 999, unitId: 'v19' },
    { date: '2026-10-06', kind: 'supplies', amount: 9, unitId: null },
  ];
  const log = [
    { vehicleId: 'v7', date: '2026-10-19', type: 'repair' },
    { vehicleId: 'v7', date: '2026-10-20', services: ['x'] },
    { vehicleId: 'v7', date: '2026-10-21', type: 'duty' },
    { vehicleId: 'v7', date: '2026-09-10', type: 'tires' },
  ];
  const days = { '2026-08-31': { miles: 10000 }, '2026-09-30': { miles: 18000 }, '2026-10-27': { miles: 24000 } };
  const { rows, totals } = unitBreakdown({ unitId: 'v7', periods, events, log, days });
  assert.deepEqual(rows.map((r) => [r.key, r.miles, r.service, r.repair, r.tires, r.shelf, r.items, r.total, r.perMile]), [
    ['2026-09', 8000, 0, 0, 1, 80, 0, 80, 0.01],
    ['2026-10', 6000, 1, 1, 0, 120, 258.25, 378.25, 0.06],
  ]);
  assert.deepEqual([totals.miles, totals.total, totals.perMile, totals.repair], [14000, 458.25, 0.03, 1]);
  const trailer = unitBreakdown({ unitId: 'v7', periods, events, log });
  assert.deepEqual([trailer.rows[1].miles, trailer.rows[1].perMile, trailer.totals.miles], [null, null, null]);
});

test('the whole fleet: every unit and the shop add up; units ranked by spend', () => {
  const periods = monthPeriods('2026-09-01', '2026-10-27');
  const units = [{ id: 'v7', name: 'T-07', trailer: false }, { id: 'v19', name: 'T-19', trailer: false }, { id: 'c1', name: '501', trailer: true }, { id: 'v9', name: 'T-09', trailer: false }];
  const events = [
    { date: '2026-10-19', kind: 'items', amount: 258.25, unitId: 'v7' },
    { date: '2026-09-10', kind: 'shelf', amount: 80, unitId: 'v7' },
    { date: '2026-10-05', kind: 'items', amount: 999, unitId: 'v19' },
    { date: '2026-10-06', kind: 'shelf', amount: 40, unitId: 'c1' },
    { date: '2026-10-07', kind: 'items', amount: 10, unitId: 'gone' }, // a unit since removed
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
  assert.deepEqual(rows.map((r) => [r.key, r.miles, r.shelf, r.items, r.shop, r.total, r.repair, r.tires, r.service]), [
    ['2026-09', 8000, 80, 0, 60, 140, 0, 0, 0],
    ['2026-10', 10000, 40, 1267.25, 9, 1316.25, 2, 1, 1],
  ]);
  assert.deepEqual(rows[1].units.map((u) => [u.name, u.total]), [['T-19', 999], ['T-07', 258.25], ['501', 40]]);
  assert.deepEqual([totals.miles, totals.total, totals.shop, totals.perMile, totals.reporting], [18000, 1456.25, 69, 0.08, 2]);
  assert.deepEqual(byUnit.map((u) => [u.name, u.total, u.work, u.miles]), [['T-19', 999, 1, 4000], ['T-07', 338.25, 1, 14000], ['501', 40, 1, null], ['T-09', 0, 1, null]]);
});
