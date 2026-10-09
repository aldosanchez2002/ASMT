import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastDoneFrom, visitServices } from '../web/maintenance.js';
import { JOBS, itemKeysFor } from '../web/services.js';
import { scheduleById } from '../scripts/schedules.mjs';

const OIL = 'detroit-dd15-ghg17-longhaul__oil';
const M1 = 'freightliner-new-cascadia-schedule2__m1';
const start = { miles: 690000, hours: 9000, date: '2026-10-05', source: 'baseline' };
const visit = (id, miles, date, services, extra = {}) => ({ id, miles, date, hours: null, services, ...extra });

test('the latest visit that covered an item is its last done', () => {
  const last = lastDoneFrom([
    visit('a', 600000, '2026-03-01', [OIL]),
    visit('b', 629123, '2026-05-01', [OIL, M1]),
    visit('c', 610000, '2026-04-01', [M1]),
  ], { [OIL]: start, [M1]: start });
  assert.equal(last[OIL].miles, 629123);
  assert.equal(last[OIL].source, 'done');
  assert.equal(last[OIL].visitId, 'b');
  assert.equal(last[M1].visitId, 'b');
});

test('items with no visit fall back to the tracking start', () => {
  const coolant = 'detroit-dd15-ghg17-longhaul__coolant-maintain';
  const last = lastDoneFrom([visit('a', 629123, '2026-05-01', [OIL])], { [OIL]: start, [coolant]: start });
  assert.equal(last[coolant], start);
});

test('deleting a visit falls back to the one before, then the tracking start', () => {
  const visits = [visit('a', 600000, '2026-03-01', [OIL]), visit('b', 629123, '2026-05-01', [OIL])];
  assert.equal(lastDoneFrom(visits.slice(0, 1), { [OIL]: start })[OIL].visitId, 'a');
  assert.equal(lastDoneFrom([], { [OIL]: start })[OIL], start);
});

test('same miles: the later date wins; undated visits still count by miles', () => {
  const last = lastDoneFrom([
    visit('a', 640000, '2026-07-01', [OIL]),
    visit('b', 640000, '2026-07-02', [OIL]),
    visit('c', 650000, null, [M1]),
  ]);
  assert.equal(last[OIL].visitId, 'b');
  assert.equal(last[M1].date, null);
  assert.equal(last[M1].miles, 650000);
});

test('duty notes and visits without miles never set a due point', () => {
  const last = lastDoneFrom([
    visit('a', null, '2026-04-01', [OIL]),
    { id: 'd', type: 'duty', miles: 700000, date: '2026-10-01', services: [OIL] },
  ], { [OIL]: start });
  assert.equal(last[OIL], start);
});

test('tracking starts only: old "done" lines in serviceRecords are ignored', () => {
  const last = lastDoneFrom([], { [OIL]: { miles: 1, date: '2026-01-01', source: 'done' } });
  assert.equal(last[OIL], undefined);
});

test('older log entry shapes still count', () => {
  assert.deepEqual(visitServices({ itemKeys: [OIL] }), [OIL]);
  assert.deepEqual(visitServices({ scheduleId: 'dot-annual', itemId: 'annual-inspection' }), ['dot-annual__annual-inspection']);
  assert.deepEqual(visitServices({ type: 'repair' }), []);
});

const tagsFor = (id) => JOBS.find((j) => j.id === id).tags;
const truck = (scheduleIds) => ({ scheduleIds });

test('a PM covers oil, fuel filters and the chassis service on each make', () => {
  const cascadia = itemKeysFor(truck(['detroit-dd15-ghg17-longhaul', 'freightliner-new-cascadia-schedule2', 'dot-annual']), tagsFor('pm'), scheduleById);
  assert.deepEqual(cascadia.sort(), [
    'detroit-dd15-ghg17-longhaul__fuel-filter-engine', 'detroit-dd15-ghg17-longhaul__fuel-filter-engine-noframe',
    'detroit-dd15-ghg17-longhaul__fuel-filter-frame', OIL, M1,
  ].sort());
  const kenworth = itemKeysFor(truck(['cummins-x15-epa2024-normal', 'kenworth-t680-onhighway']), tagsFor('pm'), scheduleById);
  assert.deepEqual(kenworth.sort(), ['cummins-x15-epa2024-normal__fuel-filter', 'cummins-x15-epa2024-normal__oil', 'kenworth-t680-onhighway__pm-15k']);
  const peterbilt = itemKeysFor(truck(['cummins-x15-2020-normal', 'peterbilt-579-onhighway']), tagsFor('pm'), scheduleById);
  assert.ok(peterbilt.includes('peterbilt-579-onhighway__pm-a'));
});

test('an oil change has no chassis service; the air filter only where the schedule has one', () => {
  const ids = ['detroit-dd15-ghg17-longhaul', 'freightliner-new-cascadia-schedule2'];
  assert.ok(!itemKeysFor(truck(ids), tagsFor('oilChange'), scheduleById).includes(M1));
  assert.deepEqual(itemKeysFor(truck(ids), tagsFor('airFilter'), scheduleById), []);
  assert.deepEqual(itemKeysFor(truck(['kenworth-t680-onhighway']), tagsFor('airFilter'), scheduleById), ['kenworth-t680-onhighway__air-filter']);
  assert.deepEqual(itemKeysFor(truck([]), tagsFor('pm'), scheduleById), []);
});
