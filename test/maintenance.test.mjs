import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mostUrgent, nextDue, recordKey, truckMaintenance } from '../web/maintenance.js';

const now = new Date('2026-10-05T12:00:00Z');
const baseline = (miles, hours = 1000, date = '2026-10-05') => ({ miles, hours, date, source: 'baseline' });
const done = (miles, hours = 1000, date = '2026-10-05') => ({ miles, hours, date, source: 'done' });

test('miles interval counts from the last service', () => {
  const r = nextDue({ intervalMiles: 60000 }, baseline(100000), { miles: 130000, hours: 1000, now });
  assert.equal(r.dueMiles, 160000);
  assert.equal(r.milesLeft, 30000);
  assert.equal(r.status, 'ok');
});

test('due soon within 10% of the interval, overdue past it', () => {
  const item = { intervalMiles: 60000 };
  assert.equal(nextDue(item, baseline(0), { miles: 54500, now }).status, 'soon');
  assert.equal(nextDue(item, baseline(0), { miles: 60001, now }).status, 'overdue');
});

test('small intervals use a 2,500 mi due-soon floor', () => {
  assert.equal(nextDue({ intervalMiles: 15000 }, baseline(0), { miles: 12600, now }).status, 'soon');
});

test('whichever comes first: months can make an item overdue', () => {
  const r = nextDue(
    { intervalMiles: 60000, intervalMonths: 12 },
    done(0, 0, '2025-09-01'),
    { miles: 1000, hours: 0, now },
  );
  assert.equal(r.status, 'overdue');
  assert.equal(r.dueDate, '2026-09-01');
  assert.ok(r.daysLeft < 0);
});

test('engine hours interval', () => {
  const r = nextDue({ intervalMiles: 35000, intervalHours: 500 }, baseline(0, 1000), { miles: 100, hours: 1460, now });
  assert.equal(r.hoursLeft, 40);
  assert.equal(r.status, 'soon');
});

test('first-due mileage applies to a baselined truck that has not reached it', () => {
  const item = { firstDueMiles: 100000, intervalMiles: 500000 };
  assert.equal(nextDue(item, baseline(7000), { miles: 7000, now }).dueMiles, 100000);
  // Already past the first-due point at baseline: regular interval from baseline
  assert.equal(nextDue(item, baseline(450000), { miles: 450000, now }).dueMiles, 950000);
  // After a logged service the regular interval applies
  assert.equal(nextDue(item, done(101000), { miles: 101000, now }).dueMiles, 601000);
});

test('one-time items: due for new trucks, n/a if already past, done once logged', () => {
  const im = { firstDueMiles: 25000 };
  assert.equal(nextDue(im, baseline(7000), { miles: 7000, now }).dueMiles, 25000);
  assert.equal(nextDue(im, baseline(600000), { miles: 600000, now }).status, 'n/a');
  assert.equal(nextDue(im, done(25100), { miles: 30000, now }).status, 'done');
});

test('items with no interval are as-needed; missing records are flagged', () => {
  assert.equal(nextDue({ notes: 'per restriction indicator' }, undefined, { miles: 1, now }).status, 'as-needed');
  assert.equal(nextDue({ intervalMiles: 1000 }, undefined, { miles: 1, now }).status, 'no-record');
});

test('truckMaintenance sorts by urgency and mostUrgent picks the worst', () => {
  const schedules = new Map([['s', {
    id: 's',
    items: [
      { id: 'oil', name: 'Oil', intervalMiles: 60000 },
      { id: 'pm', name: 'PM', intervalMiles: 25000 },
      { id: 'dot', name: 'DOT', intervalMonths: 12 },
    ],
  }]]);
  const records = {
    [recordKey('s', 'oil')]: baseline(100000),
    [recordKey('s', 'pm')]: baseline(100000),
    [recordKey('s', 'dot')]: done(0, 0, '2025-10-20'),
  };
  const rows = truckMaintenance({ odometerMiles: 120000, engineHours: 1000, scheduleIds: ['s'] }, schedules, records, now);
  // dot: 15 of ~365 days left; pm: 5,000 of 25,000 mi; oil: 40,000 of 60,000 mi
  assert.deepEqual(rows.map((r) => r.item.id), ['dot', 'pm', 'oil']);
  assert.equal(rows.find((r) => r.item.id === 'pm').status, 'ok');
  assert.equal(rows.find((r) => r.item.id === 'dot').status, 'soon'); // 15 days left
  assert.equal(mostUrgent(rows).item.id, 'dot');
});
