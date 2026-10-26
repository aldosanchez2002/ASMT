import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextText, receiptFromReading } from '../scripts/receipt-reader.mjs';

const parts = [
  { id: 'of5', name: 'Oil filter · DD15 Gen 5', number: 'A4711800209 · LF17800', unit: 'each' },
  { id: 'oil', name: 'Engine oil', unit: 'gal', packs: [{ name: 'Drum', size: 55 }] },
];
const vehicles = [{ id: 'v24', name: 'T-24', vin: '3AKJHHDR0PSNK0497' }];
const line = (over) => ({
  printed: 'X', partNumber: null, quantity: 1, unitPrice: null, lineTotal: 10, matchPartId: null, matchSure: false, matchReason: '', stockQuantity: null, truck: null, ...over,
});
const reading = (lines, over = {}) => ({ readable: true, problem: null, vendor: 'FleetPride', date: '2026-10-27', invoiceNumber: '448213', lines, tax: null, total: null, ...over });

test('the prompt lists the stock (with numbers and packs) and the trucks', () => {
  const text = contextText(parts, vehicles);
  assert.match(text, /id of5: Oil filter · DD15 Gen 5 \| numbers: A4711800209 · LF17800 \| counted in pieces/);
  assert.match(text, /id oil: Engine oil \| counted in gallons \| sold as Drum = 55 gal/);
  assert.match(text, /- T-24 VIN 3AKJHHDR0PSNK0497/);
});

test('sure matches go on the shelf; oil counts in gallons; a clean receipt is read', () => {
  const r = receiptFromReading(reading([
    line({ printed: 'DDE OIL FLTR A4711800209', partNumber: 'A4711800209', quantity: 2, unitPrice: 47.39, lineTotal: 94.78, matchPartId: 'of5', matchSure: true }),
    line({ printed: 'ROTELLA T4 DRUM', quantity: 1, lineTotal: 742.5, matchPartId: 'oil', matchSure: true, stockQuantity: 55 }),
  ], { tax: 66.85, total: 904.13 }), parts, vehicles);
  assert.equal(r.status, 'read');
  assert.deepEqual(r.lines.map((l) => [l.part, l.qty, l.price, l.to]), [['of5', 2, 94.78, 'stock'], ['oil', 55, 742.5, 'stock']]);
  assert.deepEqual(r.problems, []);
});

test('unsure matches and items off the stock list wait for a person', () => {
  const r = receiptFromReading(reading([
    line({ printed: 'OIL FILTER', matchPartId: 'of5', matchSure: false }),
    line({ printed: 'WIPER BLADE 22IN', lineTotal: 31.98 }),
  ]), parts, vehicles);
  assert.equal(r.status, 'review');
  assert.deepEqual(r.lines.map((l) => [l.part, l.suggestedPart, l.to, l.flags]), [
    [null, 'of5', null, ['unsure']],
    [null, null, null, ['notOnList']],
  ]);
});

test('a truck printed on the receipt charges that line to the truck', () => {
  const r = receiptFromReading(reading([line({ printed: 'WIPER BLADE', truck: 't-24' })]), parts, vehicles);
  assert.deepEqual([r.lines[0].to, r.lines[0].vehicleId, r.lines[0].flags], ['truck', 'v24', []]);
  assert.equal(r.status, 'read');
});

test('a total that does not add up, or oil with no gallons, is flagged', () => {
  const r = receiptFromReading(reading([line({ lineTotal: 10, matchPartId: 'of5', matchSure: true })], { tax: 1, total: 20 }), parts, vehicles);
  assert.equal(r.status, 'review');
  assert.match(r.problems[0], /come to \$11.00, but the receipt total is \$20.00/);
  const oil = receiptFromReading(reading([line({ matchPartId: 'oil', matchSure: true, stockQuantity: null })]), parts, vehicles);
  assert.deepEqual([oil.lines[0].part, oil.lines[0].flags], [null, ['quantity']]);
});

test('a date after the upload is a misread: the upload date is used and it is flagged', () => {
  const r = receiptFromReading(reading([line({ matchPartId: 'of5', matchSure: true })], { date: '2027-01-02' }), parts, vehicles, { uploadedDate: '2026-10-27' });
  assert.equal(r.date, '2026-10-27');
  assert.equal(r.status, 'review');
  assert.match(r.problems[0], /read as 2027-01-02/);
});

test('an unreadable photo says why and adds nothing', () => {
  const r = receiptFromReading({ readable: false, problem: 'Too blurry', lines: [] }, parts, vehicles, { uploadedDate: '2026-10-27' });
  assert.deepEqual([r.status, r.lines, r.problems, r.date], ['unreadable', [], ['Too blurry'], '2026-10-27']);
});
