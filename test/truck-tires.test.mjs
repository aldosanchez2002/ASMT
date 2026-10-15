import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRUCK_TIRE_POSITIONS, missingTireStarts, truckPositionName, truckTireStatus, truckTiresOverLimit,
} from '../web/truck-tires.js';

test('10 positions with readable names', () => {
  assert.equal(TRUCK_TIRE_POSITIONS.length, 10);
  assert.equal(truckPositionName('SL'), 'Steer left');
  assert.equal(truckPositionName('2RI'), 'Drive 2 right inner');
  assert.equal(truckPositionName('1LO', 'es'), 'Tracción 1 izquierda exterior');
});

test('tires count from their last replacement, or from the tracking start', () => {
  const entries = [
    { tires: ['SL', 'SR'], tireWork: 'replaced', miles: 520000, date: '2026-11-01' },
    { tires: ['SL'], tireWork: 'replaced', miles: 505000, date: '2026-10-20' },
    { tires: ['1LO'], tireWork: 'repaired', miles: 510000, date: '2026-10-25' }, // a flat fix doesn't reset
  ];
  const s = truckTireStatus(entries, 600000, { startedAt: '2026-10-15T12:00:00Z', startMiles: 500000 });
  assert.deepEqual([s.SL.miles, s.SL.since, s.SL.recorded], [80000, '2026-11-01', true]);
  assert.deepEqual([s['1LO'].miles, s['1LO'].since, s['1LO'].recorded], [100000, '2026-10-15', false]);
});

test('no tracking start and no record: miles unknown', () => {
  const s = truckTireStatus([], 600000, null);
  assert.equal(s.SL.miles, null);
  assert.deepEqual(truckTiresOverLimit(s), []);
});

test('steer and drive limits are separate', () => {
  const s = truckTireStatus([], 600000, { startedAt: '2026-10-15', startMiles: 500000 }); // 100,000 mi on every tire
  assert.deepEqual(truckTiresOverLimit(s), ['SL', 'SR']); // steer 80k, drive 150k
  assert.equal(truckTiresOverLimit(s, { steer: 120000, drive: 90000 }).length, 8);
});

test('tracking starts only for trucks without one, with miles', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const out = missingTireStarts([{ id: 'a', odometerMiles: 100 }, { id: 'b', odometerMiles: 5 }, { id: 'c', odometerMiles: null }], { b: {} }, now);
  assert.deepEqual(out, { a: { vehicleId: 'a', startedAt: '2026-10-15T12:00:00.000Z', startMiles: 100 } });
});
