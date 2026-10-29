import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complianceList, dateStatus, nextInspection, parseSheetDate, unitCompliance } from '../web/compliance.js';

const today = '2026-10-29';

test('dates as the office writes them, with impossible days moved to the end of the month', () => {
  assert.deepEqual(parseSheetDate('2027-03-31'), { date: '2027-03-31', fixed: null, state: null });
  assert.deepEqual(parseSheetDate('12/31/2026  OK'), { date: '2026-12-31', fixed: null, state: 'OK' });
  assert.deepEqual(parseSheetDate('02/28/2029 MAINE'), { date: '2029-02-28', fixed: null, state: 'ME' });
  assert.deepEqual(parseSheetDate('8/1/2026 TX '), { date: '2026-08-01', fixed: null, state: 'TX' });
  assert.deepEqual(parseSheetDate('2/29/2027'), { date: '2027-02-28', fixed: '2/29/2027', state: null });
  assert.deepEqual(parseSheetDate('09/31/2027 TX'), { date: '2027-09-30', fixed: '09/31/2027', state: 'TX' });
  assert.deepEqual(parseSheetDate('03/2024 TX'), { date: '2024-03-31', fixed: null, state: 'TX' });
  assert.deepEqual(parseSheetDate('SOLD'), { date: null, fixed: null, state: null });
});

test('each date: expired, due in 30 days, coming up in 90, ok, or missing', () => {
  assert.deepEqual(['2026-05-31', '2026-10-31', '2026-12-31', '2027-04-30', null].map((d) => dateStatus(d, today)), ['expired', 'due', 'soon', 'ok', 'missing']);
});

test('a unit is as bad as its worst date; Maine plates are multi-year; out of service needs nothing', () => {
  const t06402 = unitCompliance({ inspectionExpires: '2026-05-31', registrationExpires: '2026-08-01' }, today);
  assert.deepEqual([t06402.worst, t06402.group, t06402.inspection.days], ['expired', 'action', -151]);
  const maine = unitCompliance({ inspectionExpires: '2027-03-31', registrationExpires: '2029-02-28' }, today);
  assert.deepEqual([maine.group, maine.registration.multiYear], ['ok', true]);
  assert.equal(unitCompliance({ status: 'sold', inspectionExpires: '2024-01-31' }, today).group, 'out');
  assert.equal(unitCompliance(null, today).group, 'missing');
  assert.equal(unitCompliance({ inspectionExpires: '2027-04-30', registrationExpires: '2026-12-31' }, today).group, 'soon');
});

test('the list: what needs action first, soonest first; then coming up, no dates, ok, out of service', () => {
  const units = [{ id: 'a', name: 'ME 108' }, { id: 'b', name: '54264' }, { id: 'c', name: 'T-30' }, { id: 'd', name: '06402' }, { id: 'e', name: '54269' }, { id: 'f', name: '54015' }];
  const records = {
    a: { inspectionExpires: '2027-03-31', registrationExpires: '2030-02-28' },
    b: { inspectionExpires: '2026-10-31', registrationExpires: '2027-04-30' },
    d: { inspectionExpires: '2026-05-31', registrationExpires: '2026-08-01' },
    e: { status: 'sold' },
    f: { inspectionExpires: '2027-03-31', registrationExpires: '2026-12-01' },
  };
  assert.deepEqual(complianceList(units, records, today).map((x) => [x.name, x.group]), [
    ['06402', 'action'], ['54264', 'action'], ['54015', 'soon'], ['T-30', 'missing'], ['ME 108', 'ok'], ['54269', 'out'],
  ]);
});

test('an inspection done today is good to the end of the same month next year', () => {
  assert.equal(nextInspection('2026-10-29'), '2027-10-31');
  assert.equal(nextInspection('2027-02-10'), '2028-02-29');
});

test('a sheet row becomes a compliance record; fixed dates are listed to check; Maine plates are multi-year', async () => {
  const { recordFromRow } = await import('../scripts/import-compliance.mjs');
  assert.deepEqual(recordFromRow({ name: '109', plate: '30-60047', vin: 'V', inspection: '2/29/2027', registration: '2/28/2030 MAINE' }), {
    unitType: 'trailer', name: '109', plate: '30-60047', plateState: 'ME', vin: 'V', inspectionExpires: '2027-02-28', registrationExpires: '2030-02-28',
    registrationState: 'ME', multiYear: true, status: 'active', note: null, checkDates: ['Inspection: the sheet says 2/29/2027'],
  });
  const sold = recordFromRow({ name: '54155', plate: '222C179', vin: 'V', inspection: '2026-11-30', registration: null, note: 'SOLD', status: 'sold' });
  assert.deepEqual([sold.status, sold.registrationExpires, sold.note], ['sold', null, 'SOLD']);
});
