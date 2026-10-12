import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIRE_POSITIONS, milesOn, positionName, tireStatus, tiresOverLimit } from '../web/trailers.js';

const miles = { miles: 5200, startedAt: '2026-10-11T12:00:00Z', days: { '2026-10-11': 0, '2026-10-20': 2100, '2026-11-01': 5200 } };

test('8 positions with readable names in both languages', () => {
  assert.equal(TIRE_POSITIONS.length, 8);
  assert.equal(positionName('2RI'), 'Axle 2 right inner');
  assert.equal(positionName('1LO', 'es'), 'Eje 1 izquierda exterior');
});

test('tires count from their last change, or from tracking start', () => {
  const entries = [
    { tires: ['1LO', '2RI'], miles: 2100, date: '2026-10-20' },
    { tires: ['1LO'], miles: 300, date: '2026-10-12' },
    { type: 'repair', miles: 4000, date: '2026-10-28' },
  ];
  const s = tireStatus(entries, miles);
  assert.deepEqual([s['1LO'].miles, s['1LO'].since, s['1LO'].recorded], [3100, '2026-10-20', true]);
  assert.equal(s['2RI'].miles, 3100);
  assert.deepEqual([s['1RO'].miles, s['1RO'].since, s['1RO'].recorded], [5200, '2026-10-11', false]);
});

test('miles on a past date use the reading on or before it', () => {
  assert.equal(milesOn(miles, '2026-10-25', '2026-11-02'), 2100);
  assert.equal(milesOn(miles, '2026-10-01', '2026-11-02'), 0);
  assert.equal(milesOn(miles, '2026-11-02', '2026-11-02'), 5200); // today: the live reading
  assert.equal(milesOn(null, '2026-10-25', '2026-11-02'), 0);
});

test('tires over the miles limit, most miles first', () => {
  const status = tireStatus([{ tires: ['1LO'], miles: 50000, date: '2026-10-20' }, { tires: ['2RI'], miles: 20000, date: '2026-10-12' }], { miles: 130000 });
  assert.deepEqual(tiresOverLimit(status, 100000).slice(0, 2), ['1LI', '1RI']);
  assert.ok(!tiresOverLimit(status, 100000).includes('1LO'));
  assert.ok(tiresOverLimit(status, 100000).includes('2RI'));
  assert.ok(tiresOverLimit(status).includes('1LO')); // 80,000 mi reaches the default limit
  assert.deepEqual(tiresOverLimit(status, 200000), []);
});
