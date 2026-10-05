import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dutyFor, effectiveSettings, mostUrgent, nextDue, recordKey, resolveItems, truckMaintenance,
} from '../web/maintenance.js';

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

test('settings: defaults apply unless saved, variants and onlyWhen follow them', () => {
  const defs = [{ id: 'approvedOil', default: true }, { id: 'frameFilter', default: true }];
  assert.deepEqual(effectiveSettings(defs, {}), { approvedOil: true, frameFilter: true });
  assert.deepEqual(effectiveSettings(defs, { frameFilter: false }), { approvedOil: true, frameFilter: false });

  const schedule = {
    items: [
      { id: 'oil', name: 'Oil', intervalMiles: 60000, variants: [{ when: { approvedOil: false }, intervalMiles: 30000 }] },
      { id: 'engine-filter', name: 'Engine filter', intervalMiles: 100000, variants: [{ when: { frameFilter: false }, intervalMiles: 60000 }] },
      { id: 'frame-filter', name: 'Frame filter', intervalMiles: 60000, onlyWhen: { frameFilter: true } },
    ],
  };
  const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

  const stock = byId(resolveItems(schedule, { approvedOil: true, frameFilter: true }));
  assert.equal(stock.oil.intervalMiles, 60000);
  assert.equal(stock.oil.adjusted, undefined);
  assert.ok(stock['frame-filter']);

  const changed = byId(resolveItems(schedule, { approvedOil: false, frameFilter: false }));
  assert.equal(changed.oil.intervalMiles, 30000);
  assert.equal(changed.oil.adjusted, true);
  assert.equal(changed['engine-filter'].intervalMiles, 60000);
  assert.equal(changed['frame-filter'], undefined);
  assert.equal(changed.oil.variants, undefined);

  const rows = truckMaintenance(
    { odometerMiles: 135000, scheduleIds: ['s'] },
    new Map([['s', { id: 's', ...schedule }]]),
    { [recordKey('s', 'oil')]: baseline(100000) },
    now,
    { approvedOil: false, frameFilter: true },
  );
  assert.equal(rows.find((r) => r.item.id === 'oil').status, 'overdue');
});

test('duty cycle: byDuty overrides the base, settings variants scale or add on top', () => {
  const schedule = {
    dutyModel: 'detroit',
    items: [
      {
        id: 'oil', name: 'Oil', intervalMiles: 60000,
        byDuty: { shortHaul: { intervalMiles: 45000, intervalHours: 1000, intervalMonths: 12 }, severe: { intervalMiles: 35000, intervalHours: 750 } },
        variants: [{ when: { approvedOil: false }, scale: 0.5 }, { when: { premium: true }, addMiles: 5000 }],
      },
      { id: 'lash', name: 'Lash', intervalMiles: 200000, byDuty: { efficientLongHaul: { intervalMiles: 500000 } } },
      { id: 'hours', name: 'Hours', intervalMiles: 1, intervalHours: 10, byDuty: { shortHaul: { intervalHours: null } } },
    ],
  };
  const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));
  const on = { approvedOil: true, premium: false };

  assert.equal(byId(resolveItems(schedule, on, 'longHaul')).oil.intervalMiles, 60000);
  const sh = byId(resolveItems(schedule, on, 'shortHaul'));
  assert.deepEqual([sh.oil.intervalMiles, sh.oil.intervalHours, sh.oil.intervalMonths], [45000, 1000, 12]);
  assert.equal(sh.hours.intervalHours, undefined); // null removes a field
  assert.equal(byId(resolveItems(schedule, on, 'efficientLongHaul')).lash.intervalMiles, 500000);

  const halved = byId(resolveItems(schedule, { approvedOil: false }, 'shortHaul')).oil;
  assert.deepEqual([halved.intervalMiles, halved.intervalHours, halved.adjusted], [22500, 500, true]);
  assert.equal(byId(resolveItems(schedule, { approvedOil: true, premium: true }, 'severe')).oil.intervalMiles, 40000);

  const models = { detroit: { default: 'longHaul' } };
  assert.equal(dutyFor(schedule, models, null), 'longHaul');
  assert.equal(dutyFor(schedule, models, { current: { detroit: 'shortHaul' } }), 'shortHaul');
  assert.equal(dutyFor(schedule, models, { current: { detroit: 'shortHaul' }, override: { detroit: 'severe' } }), 'severe');
  assert.equal(dutyFor({ items: [] }, models, null), null);
});
