import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paperworkFromReading, paperworkReplyText, unitFromNote } from '../scripts/paperwork-reader.mjs';

const units = [
  { id: 'v24', name: 'T-24', unitType: 'truck', vin: '3AKJHHDR0PSNK0497', plate: 'R123456' },
  { id: 't54231', name: '54231', unitType: 'trailer', vin: null, plate: 'CU2673' },
  { id: 't108', name: '108', unitType: 'trailer', vin: null, plate: null },
  { id: 'tlc', name: 'LC106', unitType: 'trailer', vin: null, plate: null },
];
const reading = (over = {}) => ({
  readable: true, problem: null, kind: 'registration', unitNumber: null, vin: null, plate: 'CU2673', state: 'OK',
  issuedOn: '2026-11-03', inspectedOn: null, expires: '2027-12-31', fee: 85.5, agency: 'Oklahoma Tax Commission', ...over,
});
let n = 0;
const newId = () => `L${++n}`;

test('the note names the unit: trucks by T-number, trailers by their number', () => {
  assert.equal(unitFromNote('54231 registration', units)?.id, 't54231');
  assert.equal(unitFromNote('registro T-24', units)?.id, 'v24');
  assert.equal(unitFromNote('inspection 24', units)?.id, 'v24');
  assert.equal(unitFromNote('108 inspection', units)?.id, 't108'); // a trailer named 108, not T-108
  assert.equal(unitFromNote('lc106 tags', units)?.id, 'tlc');
  assert.equal(unitFromNote('registration', units), null);
  assert.equal(unitFromNote('T-24 and 54231', units), null); // two units: not sure
});

test('a registration: new expiry, plate and state for the unit, the fee as its cost', () => {
  const { receipt, change } = paperworkFromReading(reading(), units, { note: '54231 registration', docType: 'registration', newId });
  assert.equal(receipt.status, 'read');
  assert.deepEqual(receipt.lines.map((l) => [l.kind, l.text, l.cost, l.vehicleId, l.assetType]), [['paperwork', 'Registration · 54231 (to 2027-12-31)', 85.5, 't54231', 'trailer']]);
  assert.deepEqual(change.fields, { registrationExpires: '2027-12-31', plate: 'CU2673', registrationState: 'OK', plateState: 'OK' });
  assert.deepEqual(change.entry, { kind: 'registration', expires: '2027-12-31', fee: 85.5, date: '2026-11-03', plate: 'CU2673' });
  assert.equal(paperworkReplyText(receipt), 'Read registration for 54231: good to Dec 31, 2027, plate CU2673 (OK), $85.50. Updated in aslog. Wrong unit? Reply with the unit number.');
});

test('an inspection with no next date printed: good to the end of the same month next year', () => {
  const { receipt, change } = paperworkFromReading(reading({ kind: 'inspection', plate: null, state: null, expires: null, inspectedOn: '2026-11-03', fee: null }), units, { note: 'T-24 inspection', docType: 'inspection', newId });
  assert.deepEqual(change.fields, { inspectionExpires: '2027-11-30' });
  assert.deepEqual(receipt.lines, []);
  assert.equal(paperworkReplyText(receipt), 'Read inspection for T-24: good to Nov 30, 2027. Updated in aslog. Wrong unit? Reply with the unit number.');
});

test('the VIN or plate finds the unit when the note doesn\'t; doubts go to the office and change nothing', () => {
  assert.equal(paperworkFromReading(reading({ vin: '3AKJHHDR0PSNK0497', plate: null }), units, { note: 'registration', newId }).change.unitId, 'v24');
  assert.equal(paperworkFromReading(reading(), units, { note: 'registration', newId }).change.unitId, 't54231'); // by plate
  const unknown = paperworkFromReading(reading({ plate: 'ZZZ' }), units, { note: 'registration', newId });
  assert.deepEqual([unknown.change, unknown.receipt.status], [null, 'review']);
  assert.match(paperworkReplyText(unknown.receipt), /isn't clear\. The office will set it\.$/);
  const otherVin = paperworkFromReading(reading({ vin: '3AKJHHDR0PSNK0497' }), units, { note: '54231 registration', newId });
  assert.equal(otherVin.change, null);
  assert.match(otherVin.receipt.problems.join(), /VIN on the paper is T-24's, not 54231's/);
  const blurry = paperworkFromReading(reading({ readable: false, problem: 'Too dark', expires: null }), units, { note: '54231 registration', newId });
  assert.deepEqual([blurry.change, blurry.receipt.problems], [null, ['Too dark']]);
});

test('with no note, the unit number written on the paper finds the unit ("TR 54264")', () => {
  const units2 = [...units, { id: 't54264', name: '54264', unitType: 'trailer', vin: '1GRAA062X5J606374', plate: '096C699' }];
  const r = reading({ kind: 'inspection', unitNumber: 'TR 54264', vin: '1GRAA062X5J606374', plate: '096C699', state: 'TX', inspectedOn: '2026-11-04', expires: '2027-11-30', fee: 40 });
  const { change, receipt } = paperworkFromReading(r, units2, { note: null, newId });
  assert.deepEqual([change.unitId, change.fields, receipt.lines[0].cost], ['t54264', { inspectionExpires: '2027-11-30' }, 40]);
  // An FHWA form: "Trailer/Chassis Number 4002", inspected Sep 8, no next date printed.
  const units3 = [...units, { id: 't4002', name: '4002', unitType: 'trailer', vin: '1JJV532W27L008501', plate: 'CU2673' }];
  const fhwa = paperworkFromReading(reading({ kind: 'inspection', unitNumber: '4002', vin: '1JJV532W27L008501', plate: 'CU-2673', inspectedOn: '2026-09-08', expires: null, fee: null }), units3, { newId });
  assert.deepEqual([fhwa.change.unitId, fhwa.change.fields], ['t4002', { inspectionExpires: '2027-09-30' }]);
});
