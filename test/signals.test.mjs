import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOP, atShop, codeText, faultSummary, isMinorCode, quietDays } from '../web/signals.js';

test('parked in the Windermere yard counts as at the shop; driving by or far away does not', () => {
  assert.equal(atShop({ lat: 31.755254, lon: -106.235818, speedMph: 0 }), true); // T-23's spot
  assert.equal(atShop({ lat: 31.75636, lon: -106.236142, speedMph: 0 }), true); // T-46, edge of the yard
  assert.equal(atShop({ lat: 31.755254, lon: -106.235818, speedMph: 25 }), false);
  assert.equal(atShop({ lat: 31.65713, lon: -106.23281, speedMph: 0 }), false); // Doy Drive
  assert.equal(atShop(null), false);
  assert.ok(SHOP.radiusM >= 200);
});

test('quiet days count whole days since the last report', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  assert.equal(quietDays('2026-10-02T10:45:10Z', now), 7);
  assert.equal(quietDays('2026-10-09T11:00:00Z', now), 0);
  assert.equal(quietDays(null, now), null);
});

test('STOP lamp and air-system codes are never minor; body computer chatter is', () => {
  const air = { spn: 522705, fmi: 16, spnText: 'Manufacturer Assignable SPN', fmiText: 'High—moderate severity', source: 'Pneumatic - System Controller' };
  const body = { spn: 521803, fmi: 4, spnText: 'Manufacturer Assignable SPN', fmiText: 'Voltage Below Normal', source: 'Body Controller' };
  const nox = { spn: 3226, fmi: 18, spnText: 'Engine Exhaust 1 NOx 1', fmiText: 'Data Drifted Low', source: 'Engine #2' };
  assert.equal(isMinorCode(air), false);
  assert.equal(isMinorCode(body), true);
  const s = faultSummary({ lamps: { stop: true, warning: false, emissions: false, protect: false }, codes: [air, body, nox] });
  assert.equal(s.stop, true);
  assert.deepEqual(s.lamps, ['stop']);
  assert.equal(s.major.length, 2);
  assert.equal(s.minor.length, 1);
  assert.equal(codeText(air), 'Pneumatic - System Controller 522705 – High—moderate severity');
  assert.equal(codeText(nox), 'Engine Exhaust 1 NOx 1 – Data Drifted Low (Engine #2)');
  assert.equal(faultSummary({ lamps: {}, codes: [] }), null);
  assert.equal(faultSummary(null), null);
});
