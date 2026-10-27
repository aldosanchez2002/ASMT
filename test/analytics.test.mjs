import { test } from 'node:test';
import assert from 'node:assert/strict';
import { milesIn, periodsBack, unitBreakdown, workKind } from '../web/analytics.js';

test('months and weeks back from today, oldest first, the current one ending today', () => {
  assert.deepEqual(periodsBack('2026-10-27', 'month', 3), [
    { key: '2026-08', label: 'Aug', from: '2026-08-01', to: '2026-08-31' },
    { key: '2026-09', label: 'Sep', from: '2026-09-01', to: '2026-09-30' },
    { key: '2026-10', label: 'Oct', from: '2026-10-01', to: '2026-10-27' },
  ]);
  assert.deepEqual(periodsBack('2026-01-15', 'month', 2).map((p) => [p.key, p.label]), [['2025-12', 'Dec'], ['2026-01', "Jan '26"]]);
  // 2026-10-27 is a Tuesday: this week started Monday Oct 26.
  assert.deepEqual(periodsBack('2026-10-27', 'week', 2), [
    { key: '2026-10-19', label: 'Oct 19', from: '2026-10-19', to: '2026-10-25' },
    { key: '2026-10-26', label: 'Oct 26', from: '2026-10-26', to: '2026-10-27' },
  ]);
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
  const periods = periodsBack('2026-10-27', 'month', 2);
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
