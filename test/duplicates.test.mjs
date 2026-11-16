import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyToKeep, receiptFromReading, withoutDuplicate } from '../scripts/receipt-reader.mjs';
import { auditQueue, receiptItems, receiptMatch } from '../web/items.js';

const vehicles = [{ id: 'v27', name: 'T-27' }];
const reading = { readable: true, problem: null, vendor: 'Doggett Freightliner', date: '2026-11-10', time: null, invoiceNumber: 'X104788776:01', noteTrucks: [], fees: [], tax: null, total: 1400,
  lines: [{ printed: 'RAD ASSY COMPLETE', partNumber: '05-37145-000', quantity: 1, unitPrice: null, lineTotal: 1400, kind: 'part', truck: null, truckSource: null }] };
const older = { id: 'old1', vendor: 'Doggett Freightliner', invoiceNumber: 'X104788776:01', date: '2026-11-10', status: 'read' };

test('the same invoice read again knows which receipt it repeats', () => {
  const r = receiptFromReading(reading, [], vehicles, { others: [older], newId: () => 'L1' });
  assert.equal(r.duplicateOf, 'old1');
  assert.equal(r.status, 'review');
  const kept = withoutDuplicate(r);
  assert.deepEqual([kept.status, kept.problems, kept.replaced, kept.duplicateOf], ['read', [], 'old1', undefined]);
});

test('the newer copy replaces the older one, unless the admin already worked on the older one', () => {
  assert.equal(copyToKeep(older, []), 'newer');
  assert.equal(copyToKeep(older, [{ by: 'ai', status: 'doubt' }, { by: 'rule', status: 'auto' }]), 'newer');
  assert.equal(copyToKeep({ ...older, updatedAt: '2026-11-11T00:00:00Z' }, []), 'older');
  assert.equal(copyToKeep(older, [{ by: 'ai', status: 'confirmed' }]), 'older');
  assert.equal(copyToKeep(older, [{ by: 'admin', status: 'auto' }]), 'older');
});

test('a replaced copy counts for nothing and asks nothing', () => {
  const line = { id: 'a', kind: 'part', text: 'RAD ASSY COMPLETE', qty: 1, price: 1400 };
  const receipts = [
    { id: 'old1', status: 'read', date: '2026-11-10', lines: [line], replacedBy: 'new1' },
    { id: 'new1', status: 'read', date: '2026-11-10', lines: [line] },
  ];
  assert.deepEqual(receiptItems(receipts).map((it) => it.receiptId), ['new1']);
  assert.equal(receiptMatch(receipts[0], []).state, 'replaced');
  const log = [{ id: 'w', type: 'repair', date: '2026-11-14', vehicleId: 'v27', vehicleName: 'T-27', itemName: 'Cambio de Radiador' }];
  const uses = ['old1', 'new1'].map((receiptId) => ({ receiptId, lineId: 'a', logId: 'w', qty: 1, status: 'doubt', by: 'ai' }));
  const { doubts } = auditQueue({ items: receiptItems(receipts), uses, log, today: '2026-11-16' });
  assert.deepEqual(doubts.map((x) => x.use.receiptId), ['new1']);
});
