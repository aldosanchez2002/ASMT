import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteWrite, mergeWrite, setWrite } from '../scripts/firestore-rest.mjs';
import { dutyDue, onlyChanged, scheduleSignature } from '../scripts/sync-state.mjs';

const truck = (miles) => setWrite('vehicles/v1', { name: 'T-24', odometerMiles: miles }, 'updatedAt');

test('an unchanged document is not written again; a changed one is', () => {
  const first = onlyChanged([truck(100), setWrite('meta/sync', { n: 1 }, 'lastRun')], {}, { always: ['meta/sync'] });
  assert.equal(first.writes.length, 2);
  const same = onlyChanged([truck(100), setWrite('meta/sync', { n: 1 }, 'lastRun')], first.state, { always: ['meta/sync'] });
  assert.deepEqual([same.writes.length, same.skipped], [1, 1]); // only meta/sync, every run
  const moved = onlyChanged([truck(101)], first.state);
  assert.equal(moved.writes.length, 1);
});

test('a merge into a new field (today\'s odometer reading) counts as a change', () => {
  const a = onlyChanged([mergeWrite('odometerDaily/v1', { 'days.`2026-11-24`': { miles: 1 } })], {});
  const b = onlyChanged([mergeWrite('odometerDaily/v1', { 'days.`2026-11-25`': { miles: 1 } })], a.state);
  assert.equal(b.writes.length, 1);
});

test('a document already deleted is not deleted again, and comes back when written', () => {
  const a = onlyChanged([deleteWrite('vehicles/old')], {});
  assert.deepEqual([a.writes.length, a.state.gone], [1, ['vehicles/old']]);
  const b = onlyChanged([deleteWrite('vehicles/old')], a.state);
  assert.deepEqual([b.writes.length, b.skipped], [0, 1]);
  const c = onlyChanged([setWrite('vehicles/old', { name: 'T-09' })], b.state);
  assert.deepEqual([c.writes.length, c.state.gone], [1, []]);
});

test('duty cycles every 6 hours; schedule signatures', () => {
  const now = Date.parse('2026-11-24T18:00:00Z');
  assert.equal(dutyDue({}, now), true);
  assert.equal(dutyDue({ dutyAt: '2026-11-24T13:00:00Z' }, now), false);
  assert.equal(dutyDue({ dutyAt: '2026-11-24T11:59:00Z' }, now), true);
  assert.equal(scheduleSignature({ id: 'v1', scheduleIds: ['b', 'a'] }), 'v1:a+b');
});
