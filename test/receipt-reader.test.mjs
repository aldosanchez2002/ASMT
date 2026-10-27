import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextText, receiptFromReading } from '../scripts/receipt-reader.mjs';

const parts = [
  { id: 'of5', name: 'Oil filter · DD15 Gen 5', number: 'A4711800209 · LF17800', unit: 'each' },
  { id: 'oil', name: 'Engine oil', unit: 'gal', packs: [{ name: 'Drum', size: 55 }] },
];
const vehicles = [{ id: 'v24', name: 'T-24', vin: '3AKJHHDR0PSNK0497' }, { id: 'v31', name: 'T-31' }];
const line = (over) => ({
  printed: 'X', partNumber: null, quantity: 1, unitPrice: null, lineTotal: 10, kind: 'part', matchPartId: null, matchSure: false, matchReason: '', stockQuantity: null, truck: null, truckSource: null, ...over,
});
const reading = (lines, over = {}) => ({ readable: true, problem: null, vendor: 'FleetPride', date: '2026-10-27', time: null, invoiceNumber: '448213', noteTrucks: [], lines, fees: [], tax: null, total: null, ...over });
let n = 0;
const newId = () => `L${++n}`;
const read = (r, opts = {}) => receiptFromReading(r, parts, vehicles, { newId, ...opts });

test('the prompt lists the stock (with numbers and packs), the trucks, the memory and the note', () => {
  const text = contextText(parts, vehicles);
  assert.match(text, /id of5: Oil filter · DD15 Gen 5 \| numbers: A4711800209 · LF17800 \| counted in pieces/);
  assert.match(text, /id oil: Engine oil \| counted in gallons \| sold as Drum = 55 gal/);
  assert.match(text, /- T-24 VIN 3AKJHHDR0PSNK0497/);
  assert.doesNotMatch(text, /note/);
  const full = contextText(parts, vehicles, 'T-24 drums,\n31 headlight', 'What the admin told you: balatas = brake shoes');
  assert.match(full, /balatas = brake shoes\n\nThe buyer's note sent with the photo: "T-24 drums, 31 headlight"/);
});

test('sure matches go on the shelf; oil counts in gallons; a clean receipt is read', () => {
  const r = read(reading([
    line({ printed: 'DDE OIL FLTR A4711800209', partNumber: 'A4711800209', quantity: 2, unitPrice: 47.39, lineTotal: 94.78, matchPartId: 'of5', matchSure: true }),
    line({ printed: 'ROTELLA T4 DRUM', quantity: 1, lineTotal: 742.5, matchPartId: 'oil', matchSure: true, stockQuantity: 55 }),
  ], { tax: 66.85, total: 904.13 }));
  assert.equal(r.status, 'read');
  assert.deepEqual(r.lines.map((l) => [l.part, l.kind, l.qty, l.price, l.to]), [['of5', 'stock', 2, 94.78, 'stock'], ['oil', 'stock', 55, 742.5, 'stock']]);
  assert.ok(r.lines.every((l) => /^L\d+$/.test(l.id)));
  assert.deepEqual(r.problems, []);
});

test('repair parts with no truck go to the pool without a flag; supplies and tools go to the shop', () => {
  const r = read(reading([
    line({ printed: 'DRUM-BRAKE 16.5X5', partNumber: 'DB1655B', quantity: 2, lineTotal: 231.62 }),
    line({ printed: 'BRAKE CLEANER', kind: 'supplies', lineTotal: 8 }),
    line({ printed: '1/2 DR SOCKET SET', kind: 'tool', lineTotal: 60 }),
    line({ printed: 'CORE CHARGE', kind: 'core', lineTotal: 50 }),
  ]));
  assert.deepEqual(r.lines.map((l) => [l.kind, l.to, l.flags]), [['part', null, []], ['supplies', 'shop', []], ['tool', 'shop', []], ['core', null, []]]);
  assert.equal(r.status, 'read');
});

test('an unsure stock match waits for a person with the best guess', () => {
  const r = read(reading([line({ printed: 'OIL FILTER', matchPartId: 'of5', matchSure: false })]));
  assert.equal(r.status, 'review');
  assert.deepEqual([r.lines[0].part, r.lines[0].suggestedPart, r.lines[0].to, r.lines[0].flags], [null, 'of5', null, ['unsure']]);
});

test('each line gets its share of tax and fees; the fees count in the math (the MHC card fee)', () => {
  const r = read(reading([line({ printed: 'DRUM-BRAKE 16.5X5', quantity: 2, lineTotal: 231.62 })], {
    fees: [{ label: 'CC FEE', amount: 6.95 }], tax: 19.68, total: 258.25,
  }));
  assert.deepEqual([r.lines[0].cost, r.feesTotal, r.fees, r.problems, r.status], [258.25, 6.95, [{ label: 'CC FEE', amount: 6.95 }], [], 'read']);
  const split = read(reading([line({ lineTotal: 30 }), line({ lineTotal: 70 }), line({ lineTotal: -10, kind: 'credit' })], { tax: 8.25, total: 98.25 }));
  assert.deepEqual(split.lines.map((l) => [l.kind, l.cost]), [['part', 32.48], ['part', 75.77], ['credit', -10]]);
});

test('a truck printed on the receipt ties the line to the truck', () => {
  const r = read(reading([line({ printed: 'WIPER BLADE', truck: 't-24', truckSource: 'printed' })]));
  assert.deepEqual([r.lines[0].to, r.lines[0].vehicleId, r.lines[0].truckFrom, r.lines[0].flags], ['truck', 'v24', 'printed', []]);
  assert.equal(r.status, 'read');
});

test('a note naming one truck puts every item on it; stock parts go on the shelf "for" it', () => {
  const r = read(reading([
    line({ printed: 'DRUM-BRAKE 16.5X5' }),
    line({ printed: 'DDE OIL FLTR', matchPartId: 'of5', matchSure: true }),
    line({ printed: 'RAGS', kind: 'supplies' }),
  ]), { trucks: ['T-24'] });
  assert.deepEqual(r.lines.map((l) => [l.to, l.vehicleId, l.for?.[0].name ?? null, l.truckFrom]), [
    ['truck', 'v24', null, 'note'],
    ['stock', null, 'T-24', 'note'],
    ['shop', null, null, null],
  ]);
});

test('a note naming several trucks: items it ties go to them; the rest go to the pool with only those trucks as choices', () => {
  const r = read(reading([
    line({ printed: 'DRUM-BRAKE', truck: 'T-24', truckSource: 'note' }),
    line({ printed: 'HEADLAMP', truck: 'T-31', truckSource: 'handwritten' }),
    line({ printed: 'SLACK ADJ' }),
  ], { noteTrucks: ['T-31'] }), { trucks: ['T-24'] });
  assert.deepEqual(r.lines.map((l) => [l.vehicleId, l.truckFrom, l.flags, l.truckChoices]), [
    ['v24', 'note', [], null],
    ['v31', 'handwritten', [], null],
    [null, null, [], ['v24', 'v31']],
  ]);
  assert.equal(r.status, 'read');
});

test('a truck name not in the list is ignored', () => {
  const r = read(reading([line({ printed: 'WIPER', truck: 'T-99', truckSource: 'handwritten' })]));
  assert.deepEqual([r.lines[0].to, r.lines[0].truckFrom], [null, null]);
});

test('a total that does not add up, or oil with no gallons, is flagged', () => {
  const r = read(reading([line({ lineTotal: 10, matchPartId: 'of5', matchSure: true })], { tax: 1, total: 20 }));
  assert.equal(r.status, 'review');
  assert.match(r.problems[0], /come to \$11.00, but the receipt total is \$20.00/);
  const oil = read(reading([line({ matchPartId: 'oil', matchSure: true, stockQuantity: null })]));
  assert.deepEqual([oil.lines[0].part, oil.lines[0].flags], [null, ['quantity']]);
});

test('the time printed on the receipt is kept when it is a real time', () => {
  assert.equal(read(reading([line({})], { time: '11:43' })).time, '11:43');
  assert.equal(read(reading([line({})], { time: '11:43:50AM' })).time, null);
  assert.equal(read(reading([line({})], { time: null })).time, null);
});

test('the same invoice uploaded twice is flagged', () => {
  const r = read(reading([line({})], { invoiceNumber: 'T00655601068569', vendor: 'MHC Kenworth' }), {
    others: [{ id: 'x', invoiceNumber: 't-00655601068569', vendor: 'mhc kenworth', date: '2026-10-21' }],
  });
  assert.equal(r.status, 'review');
  assert.match(r.problems[0], /already uploaded \(2026-10-21\)/);
});

test('a date after the upload is a misread: the upload date is used and it is flagged', () => {
  const r = read(reading([line({ matchPartId: 'of5', matchSure: true })], { date: '2027-01-02' }), { uploadedDate: '2026-10-27' });
  assert.equal(r.date, '2026-10-27');
  assert.equal(r.status, 'review');
  assert.match(r.problems[0], /read as 2027-01-02/);
});

test('an unreadable photo says why and adds nothing', () => {
  const r = read({ readable: false, problem: 'Too blurry', lines: [] }, { uploadedDate: '2026-10-27' });
  assert.deepEqual([r.status, r.lines, r.problems, r.date], ['unreadable', [], ['Too blurry'], '2026-10-27']);
});
