import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemKeysFor, localVehicleId, planWorkLog } from '../scripts/work-log.mjs';

const cascadia = {
  id: '111', name: 'T-23', odometerMiles: 692017,
  scheduleIds: ['detroit-dd15-ghg17-longhaul', 'freightliner-new-cascadia-schedule2', 'dot-annual'],
};
const kenworth = {
  id: '222', name: 'T-43', odometerMiles: 51129,
  scheduleIds: ['cummins-x15-epa2024-normal', 'kenworth-t680-onhighway', 'dot-annual'],
};
const vehicles = { 111: cascadia, 222: kenworth };
const OIL = 'detroit-dd15-ghg17-longhaul__oil';
const baseline = { miles: 690000, hours: 9000, date: '2026-10-02', source: 'baseline' };

test('services map to the items each truck\'s schedules have', () => {
  const keys = itemKeysFor(cascadia, ['oil', 'fuelFilters', 'chassisPm', 'airFilter']);
  assert.ok(keys.includes(OIL));
  assert.ok(keys.includes('detroit-dd15-ghg17-longhaul__fuel-filter-frame'));
  assert.ok(keys.includes('freightliner-new-cascadia-schedule2__m1'));
  // The Freightliner chassis schedule has no air filter item.
  assert.ok(!keys.some((k) => k.includes('air-filter')));
  const kw = itemKeysFor(kenworth, ['oil', 'fuelFilters', 'airFilter']);
  assert.deepEqual(kw.sort(), [
    'cummins-x15-epa2024-normal__fuel-filter', 'cummins-x15-epa2024-normal__oil', 'kenworth-t680-onhighway__air-filter',
  ]);
});

test('the latest logged service replaces the launch-day tracking start', () => {
  const log = {
    entries: [
      { unit: 'T-23', date: '2026-03-01', miles: 600000, work: 'Oil change', written: 'Oil change', services: ['oil'] },
      { unit: 'T-23', date: '2026-05-01', miles: 629123, work: 'Oil change', written: 'Oil change', services: ['oil'] },
      { unit: 'T-23', date: '2026-03-20', miles: null, work: 'Fuel injector', written: 'Fuel injector', services: [], repair: true },
    ],
  };
  const plan = planWorkLog(log, vehicles, { 111: { items: { [OIL]: baseline } } });
  const oil = plan.recordChanges.find((c) => c.key === OIL);
  assert.equal(oil.before, baseline);
  assert.equal(oil.after.miles, 629123);
  assert.equal(oil.after.source, 'done');
  assert.equal(Object.keys(plan.logEntries).length, 3);
  const repair = Object.values(plan.logEntries).find((e) => e.itemName === 'Fuel injector');
  assert.equal(repair.type, 'repair');
  assert.deepEqual(plan.problems, []);
});

test('a newer "Mark done" from the app is kept', () => {
  const marked = { miles: 691000, date: '2026-10-05', source: 'done' };
  const log = { entries: [{ unit: 'T-23', date: '2026-05-01', miles: 629123, work: 'Oil', written: 'Oil', services: ['oil'] }] };
  const plan = planWorkLog(log, vehicles, { 111: { items: { [OIL]: marked } } });
  assert.equal(plan.recordChanges.find((c) => c.key === OIL), undefined);
});

test('a service with no miles goes in the log only', () => {
  const log = { entries: [{ unit: 'T-23', date: '2026-04-01', miles: null, work: 'Air dryer', written: 'Air dryer', services: ['airDryer'] }] };
  const plan = planWorkLog(log, vehicles, {});
  assert.equal(plan.recordChanges.length, 0);
  assert.equal(Object.keys(plan.logEntries).length, 1);
  assert.match(plan.problems[0], /no miles/);
});

test('local trucks, unknown units and out-of-service trucks', () => {
  const log = {
    localTrucks: [{ name: 'A22' }],
    outOfService: [{ name: 'T-23', reason: 'Engine overhaul' }],
    entries: [
      { unit: 'A22', date: '2026-07-28', miles: 26768, work: 'PM', written: 'PM', services: ['oil'] },
      { unit: 'A22', date: '2026-09-12', miles: 55203, work: 'Oil change', written: 'Oil', services: ['oil'] },
      { unit: 'T-99', date: '2026-09-12', miles: 1, work: 'Oil change', written: 'Oil', services: ['oil'] },
    ],
  };
  const plan = planWorkLog(log, vehicles, {});
  const a22 = plan.localVehicles[localVehicleId('A22')];
  assert.equal(a22.local, true);
  assert.equal(a22.odometerMiles, 55203);
  assert.deepEqual(a22.scheduleIds, []);
  assert.equal(Object.values(plan.logEntries).filter((e) => e.vehicleId === a22.id).length, 2);
  assert.equal(plan.statusDocs[111].outOfService, true);
  assert.match(plan.problems.join('\n'), /T-99/);
});
