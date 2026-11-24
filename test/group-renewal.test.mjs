import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRenewal, splitEvenly } from '../web/compliance.js';
import { costEvents } from '../web/items.js';
import { spendByKind } from '../web/analytics.js';

test('a total splits to the cent', () => {
  assert.deepEqual(splitEvenly(100, 3), [33.34, 33.33, 33.33]);
  assert.deepEqual(splitEvenly(2977.2, 12).reduce((s, x) => Math.round((s + x) * 100) / 100, 0), 2977.2);
  assert.deepEqual(splitEvenly(null, 2), [null, null]);
});

test('renewing several units together: one receipt, a line and a new date per unit', () => {
  let n = 0;
  const units = [{ id: 'v24', name: 'T-24', unitType: 'truck', share: 248.1 }, { id: 'c9', name: '54231', unitType: 'trailer', share: 151.9 }];
  const { receipt, changes } = groupRenewal({ kind: 'registration', units, expires: '2027-12-31', date: '2026-12-02', agency: 'IRP office', receiptId: 'g1', newId: () => `L${++n}` });
  assert.deepEqual([receipt.total, receipt.status, receipt.paperwork.unitName, receipt.lines.length], [400, 'read', '2 units', 2]);
  assert.deepEqual(changes.map((c) => [c.unitId, c.fields.registrationExpires, c.entry.fee, c.entry.group, c.entry.groupTotal]), [['v24', '2027-12-31', 248.1, 2, 400], ['c9', '2027-12-31', 151.9, 2, 400]]);
  // Each share is that unit's cost, under Inspection & registrations.
  const events = costEvents({ receipts: [{ id: 'g1', ...receipt }], uses: [], log: [] });
  assert.deepEqual(events.map((e) => [e.unitId, e.amount, e.paperwork]), [['v24', 248.1, true], ['c9', 151.9, true]]);
  assert.deepEqual(spendByKind({ events, log: [], from: '2026-12-01', to: '2026-12-31' }).map((k) => [k.key, k.amount]), [['paperwork', 400]]);
});

test('an inspection renewal sets the inspection date; no fee means no cost', () => {
  const { receipt, changes } = groupRenewal({ kind: 'inspection', units: [{ id: 'v1', name: 'T-01', unitType: 'truck', share: null }], expires: '2027-11-30', date: '2026-11-25', receiptId: 'g2', newId: () => 'x' });
  assert.deepEqual([receipt.total, changes[0].fields], [null, { inspectionExpires: '2027-11-30' }]);
  assert.deepEqual(costEvents({ receipts: [{ id: 'g2', ...receipt }], uses: [], log: [] }), []);
});
