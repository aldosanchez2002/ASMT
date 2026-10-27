import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateRepairs, matchContext, matchSignature, usesFromAnswer } from '../scripts/item-matcher.mjs';
import { memoryText } from '../scripts/ai-memory.mjs';

const item = (over) => ({
  key: 'r1:a', receiptId: 'r1', lineId: 'a', text: 'DRUM-BRAKE 16.5X5', partNumber: 'DB1655B', kind: 'part',
  qty: 2, remaining: 2, unitCost: 129.13, date: '2026-10-21', vendor: 'MHC', vehicleId: null, truckChoices: null, ...over,
});
const repairs = [
  { id: 'e1', type: 'repair', date: '2026-10-19', vehicleId: 'v7', vehicleName: 'T-07', itemName: 'Disco delantero copiloto se remplazo' },
  { id: 'e2', type: 'repair', date: '2026-10-22', vehicleId: 'v19', vehicleName: 'T-19', itemName: 'Cambio de balatas 1er eje copiloto', note: 'y tambores' },
  { id: 'e3', type: 'repair', date: '2026-08-01', vehicleId: 'v7', vehicleName: 'T-07', itemName: 'Air bag' },
];
const names = new Map([['v7', 'T-07'], ['v19', 'T-19']]);

test('only repairs in some item\'s window go to Claude', () => {
  assert.deepEqual(candidateRepairs([item()], repairs).map((e) => e.id), ['e1', 'e2']);
});

test('the context lists items and repairs with refs, trucks, what repairs already have and what admin rejected', () => {
  const items = [item(), item({ key: 'r2:b', receiptId: 'r2', lineId: 'b', text: 'HEADLAMP', partNumber: null, kind: 'part', remaining: 1, unitCost: 90, vehicleId: 'v19' }), item({ key: 'r3:c', receiptId: 'r3', lineId: 'c', text: 'CORE', kind: 'core', truckChoices: ['v7', 'v19'], remaining: 1, unitCost: null })];
  const uses = [
    { receiptId: 'r1', lineId: 'a', logId: 'e2', status: 'rejected' },
    { receiptId: 'r9', lineId: 'z', logId: 'e1', status: 'confirmed' },
  ];
  const all = [...items, item({ key: 'r9:z', text: 'SLACK ADJUSTER' })];
  const { text, refs } = matchContext(items, repairs.slice(0, 2), { names, uses, allItems: all, memory: 'What the admin told you: tambores = drums' });
  assert.match(text, /I1: "DRUM-BRAKE 16.5X5" \(DB1655B\) x2, \$129.13 each, bought 2026-10-21 at MHC; admin said NOT R2/);
  assert.match(text, /I2: "HEADLAMP" x1, \$90.00 each, bought 2026-10-21 at MHC; bought for T-19/);
  assert.match(text, /I3: \[core\] "CORE" \(DB1655B\) x1, bought 2026-10-21 at MHC; could be T-07 or T-19/);
  assert.match(text, /R1: 2026-10-19 T-07: "Disco delantero copiloto se remplazo"; already has: SLACK ADJUSTER/);
  assert.match(text, /R2: 2026-10-22 T-19: "Cambio de balatas 1er eje copiloto · y tambores"/);
  assert.match(text, /tambores = drums/);
  assert.equal(refs.items.get('I2').key, 'r2:b');
});

test('Claude\'s answer becomes uses: sure ones count, unsure ones wait, bad ones are dropped', () => {
  const items = [item(), item({ key: 'r2:b', receiptId: 'r2', lineId: 'b', text: 'HEADLAMP', remaining: 1, vehicleId: 'v19' })];
  const { refs } = matchContext(items, repairs, { names });
  const uses = usesFromAnswer({
    matches: [
      { item: 'I1', repair: 'R1', qty: 1, confidence: 92, reason: 'Drum replaced on T-07 two days before.' },
      { item: 'I1', repair: 'R2', qty: 5, confidence: 70, reason: 'Drums with the brake job.' }, // only 1 left
      { item: 'I1', repair: 'R3', qty: 1, confidence: 95, reason: 'out of window' },
      { item: 'I2', repair: 'R1', qty: 1, confidence: 95, reason: 'Headlight.' }, // bought for T-19
      { item: 'I9', repair: 'R1', qty: 1, confidence: 99, reason: 'unknown item' },
    ],
  }, refs, { names });
  assert.deepEqual(uses.map((u) => [u.lineId, u.logId, u.qty, u.status, u.confidence, u.vehicleName]), [
    ['a', 'e1', 1, 'auto', 92, 'T-07'],
    ['a', 'e2', 1, 'doubt', 70, 'T-19'],
    ['b', 'e1', 1, 'doubt', 50, 'T-07'],
  ]);
  assert.match(uses[2].reason, /different truck/);
  const again = usesFromAnswer({ matches: [{ item: 'I1', repair: 'R1', qty: 1, confidence: 99, reason: 'x' }] }, refs, { uses: [{ receiptId: 'r1', lineId: 'a', logId: 'e1', status: 'rejected' }] });
  assert.deepEqual(again, []);
});

test('the signature changes when the open items or repairs change', () => {
  const a = matchSignature([item()], repairs);
  assert.equal(a, matchSignature([item()], [...repairs].reverse()));
  assert.notEqual(a, matchSignature([item({ remaining: 1 })], repairs));
});

test('memory: admin notes and recent corrections, per prompt', () => {
  const corrections = [
    { type: 'reading', at: '2026-10-20T00:00:00Z', vendor: 'Doggett', text: 'SURCHARGE', partNumber: null, before: { kind: 'part', qty: 1, price: 4 }, after: null },
    { type: 'reading', at: '2026-10-22T00:00:00Z', vendor: 'MHC', text: 'FLTR', partNumber: 'LF17800', before: { kind: 'part', qty: 1, price: 40 }, after: { part: 'of5', qty: 1, price: 40 } },
    { type: 'match', at: '2026-10-23T00:00:00Z', itemText: 'DRUM-BRAKE', partNumber: 'DB1655B', vendor: 'MHC', itemDate: '2026-10-21', ai: { repair: 'Air bag', truck: 'T-07', date: '2026-10-19', confidence: 70 }, admin: { repair: 'Cambio de balatas', truck: 'T-19', date: '2026-10-22' } },
    { type: 'match', at: '2026-10-24T00:00:00Z', itemText: 'BRAKE CLEANER', itemDate: '2026-10-21', ai: null, admin: { shop: true } },
  ];
  const parts = [{ id: 'of5', name: 'Oil filter · DD15 Gen 5' }];
  const reading = memoryText('reading', { notes: 'Doggett "surcharge" is a fee.' }, corrections, parts);
  assert.match(reading, /^What the shop's admin has told you \(follow it\):\nDoggett "surcharge" is a fee\./);
  assert.match(reading, /- "FLTR" \(LF17800\) at MHC: you said part, qty 1, \$40.00; it was stock part Oil filter · DD15 Gen 5\.\n- "SURCHARGE" at Doggett: you read this line, but it isn't an item/);
  const match = memoryText('match', {}, corrections);
  assert.match(match, /- "BRAKE CLEANER" bought 2026-10-21: you said no repair; it was shop supplies/);
  assert.match(match, /- "DRUM-BRAKE" \(DB1655B\) bought 2026-10-21 at MHC: you said the repair "Air bag" on T-07 \(2026-10-19\); it was the repair "Cambio de balatas" on T-19 \(2026-10-22\)\./);
  assert.equal(memoryText('match', {}, []), '');
});
