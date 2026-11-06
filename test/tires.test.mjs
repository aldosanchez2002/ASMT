import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptFromReading } from '../scripts/receipt-reader.mjs';
import { readReplyText } from '../scripts/receipt-reply.mjs';
import { auditQueue, costEvents, isTireText, receiptItems, receiptMatch, tireType, tireUses } from '../web/items.js';

const vehicles = [{ id: 'v24', name: 'T-24' }, { id: 'v31', name: 'T-31' }];
const line = (over) => ({ printed: 'X', partNumber: null, quantity: 1, unitPrice: null, lineTotal: 10, kind: 'part', truck: null, truckSource: null, ...over });
const reading = (lines, over = {}) => ({ readable: true, problem: null, vendor: 'Southern Tire Mart', date: '2026-10-20', time: null, invoiceNumber: null, noteTrucks: [], lines, fees: [], tax: null, total: null, ...over });
let n = 0;
const read = (r, opts = {}) => receiptFromReading(r, [], vehicles, { newId: () => `L${++n}`, ...opts });

test('what counts as a tire, and which kind', () => {
  assert.deepEqual(['295/75R22.5 DRIVE TIRE', '11R22.5 BRIDGESTONE M726', 'LLANTA 11R24.5', 'STEER TIRE 315/80R22.5'].map(isTireText), [true, true, true, true]);
  assert.deepEqual(['TIRE FEE', 'TIRE MOUNT', 'VALVE STEM 11R22.5', 'TIRE CHAIN', 'TIRE DISPOSAL FEE', 'OIL FILTER'].map(isTireText), [false, false, false, false, false, false]);
  assert.deepEqual(['STEER TIRE', '295/75R22.5 DRIVE', 'TRAILER TIRE 11R22.5', '11R22.5 M726'].map(tireType), ['steer', 'drive', 'trailer', null]);
});

test('the reader ignores the unit number on tires, from the receipt or the note; other lines keep it', () => {
  const r = read(reading([
    line({ printed: '295/75R22.5 DRIVE TIRE', quantity: 4, lineTotal: 1180, truck: 'T-24', truckSource: 'printed' }),
    line({ printed: 'MUD FLAP', lineTotal: 40 }),
  ]), { trucks: ['T-31'] });
  const [tire, flap] = r.lines;
  assert.deepEqual([tire.to, tire.vehicleId, tire.truckFrom, tire.tire, tire.unitOnReceipt], [null, null, null, true, 'T-24']);
  assert.deepEqual([flap.to, flap.vehicleId], ['truck', 'v31']);
  assert.equal(readReplyText({ ...r, total: 1220 }, vehicles),
    'Read Southern Tire Mart $1220.00: 4 × 295/75R22.5 DRIVE TIRE and MUD FLAP for T-31. Wrong truck? Reply with the truck number. Tires get tied to a truck when the tire change is logged.');
});

test('a receipt that charges for mounting or a road call keeps the unit: the tire went on right there', () => {
  const r = read(reading([
    line({ printed: '11R22.5 STEER TIRE', lineTotal: 380 }),
    line({ printed: 'ROAD SERVICE CALL', kind: 'labor', lineTotal: 150 }),
  ]), { trucks: ['T-24'] });
  assert.deepEqual(r.lines.map((l) => [l.vehicleId, l.tire ?? false]), [['v24', false], ['v24', false]]);
});

// Two tire receipts and three tire changes.
const receipts = [
  { id: 'r1', status: 'read', date: '2026-10-01', vendor: 'Southern Tire Mart', lines: [{ id: 'a', kind: 'part', text: '11R22.5 DRIVE TIRE', qty: 4, price: 1600, tire: true, unitOnReceipt: 'T-99' }] },
  { id: 'r2', status: 'read', date: '2026-10-10', vendor: 'Southern Tire Mart', lines: [
    { id: 'b', kind: 'part', text: '295/80R22.5 STEER TIRE', qty: 2, price: 900, tire: true },
    { id: 'c', kind: 'part', text: '11R22.5 DRIVE TIRE', qty: 2, price: 820, tire: true },
  ] },
];
const log = [
  { id: 'w1', type: 'tires', date: '2026-10-05', vehicleId: 'v24', vehicleName: 'T-24', tires: ['2LO', '2RO'] },
  { id: 'w2', type: 'tires', date: '2026-10-12', vehicleId: 'v31', vehicleName: 'T-31', tires: ['1LO', '3RI', '3RO'] },
  { id: 'w0', type: 'tires', date: '2026-09-28', vehicleId: 'v31', vehicleName: 'T-31', tires: ['1RO'] }, // before any tire was bought
];

test('each tire change takes the oldest tires bought by that day, of the right kind first', () => {
  const uses = tireUses({ receipts, uses: [], log });
  assert.deepEqual(uses.map((u) => [u.logId, u.receiptId, u.lineId, u.qty, u.vehicleName, u.by, u.status]), [
    ['w1', 'r1', 'a', 2, 'T-24', 'rule', 'auto'],
    ['w2', 'r2', 'b', 1, 'T-31', 'rule', 'auto'], // axle 1: a steer tire
    ['w2', 'r1', 'a', 2, 'T-31', 'rule', 'auto'], // the drive axle: the oldest drive tires
  ]);
  // The cost goes to the unit that got them, at the receipt's price.
  const events = costEvents({ receipts, uses, log });
  const parts = events.filter((ev) => ev.kind === 'parts');
  assert.deepEqual(parts.map((ev) => [ev.unitId, ev.amount]), [['v24', 800], ['v31', 800], ['v31', 450]]);
  // What's left is on hand: 1 steer and 2 drive tires.
  assert.deepEqual(events.filter((ev) => ev.kind === 'open').map((ev) => [ev.lineId, ev.amount]), [['b', 450], ['c', 820]]);
});

test('a tire change already covered isn\'t covered again; one covered by half takes the rest', () => {
  const first = tireUses({ receipts, uses: [], log });
  assert.deepEqual(tireUses({ receipts, uses: first, log }), []);
  const half = [{ receiptId: 'r1', lineId: 'a', logId: 'w2', qty: 1, tire: true, status: 'confirmed' }];
  const rest = tireUses({ receipts, uses: half, log: log.filter((e) => e.id === 'w2') });
  assert.deepEqual(rest.map((u) => [u.lineId, u.qty]), [['a', 2]]);
});

test('a tire someone tied to a unit by hand isn\'t pooled', () => {
  const tied = [{ ...receipts[0], lines: [{ ...receipts[0].lines[0], to: 'truck', vehicleId: 'v24' }] }];
  assert.equal(receiptItems(tied)[0].tire, undefined);
  assert.deepEqual(tireUses({ receipts: tied, uses: [], log }), []);
});

test('tires on hand say why on the receipt, and aren\'t flagged as parts no work explains', () => {
  const { open } = receiptMatch(receipts[0], []);
  assert.deepEqual(open.map((x) => [x.why, x.unitOnReceipt]), [['tire', 'T-99']]);
  const items = receiptItems(receipts);
  assert.deepEqual(auditQueue({ items, uses: [], log, today: '2026-11-06' }).noWork, []);
});
