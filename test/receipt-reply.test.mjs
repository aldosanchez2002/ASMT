import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReplyText, sendReadReply, READ_REPLY_URL } from '../scripts/receipt-reply.mjs';

const vehicles = [{ id: 'v24', name: 'T-24' }, { id: 'v31', name: 'T-31' }];

test('the reading reply: store, total, items, and the truck when one was named', () => {
  const tied = { status: 'read', vendor: 'FleetPride', total: 12.4, lines: [{ text: 'Oil filter, DD15', qty: 1, kind: 'part', to: 'truck', vehicleId: 'v24' }] };
  assert.equal(readReplyText(tied, vehicles), 'Read FleetPride $12.40: Oil filter for T-24. Wrong truck? Reply with the truck number.');
  // No truck on the receipt or in a text: it doesn't ask for one.
  const loose = { status: 'read', vendor: "ALDO'S DEMO TRUCK PART STORE", total: 96.88, lines: [{ text: 'HEADLIGHT ASSY LH Halogen, DOT approved', qty: 1, kind: 'part' }] };
  assert.equal(readReplyText(loose, vehicles), "Read ALDO'S DEMO TRUCK PART STORE $96.88: HEADLIGHT ASSY LH Halogen.");
  // Shelf stock and shop supplies need no truck.
  const shelf = { status: 'read', vendor: 'NAPA', total: 300, lines: [{ text: 'Oil filter', qty: 6, kind: 'stock', to: 'stock' }, { text: 'Shop towels', qty: 2, kind: 'supplies', to: 'shop' }] };
  assert.equal(readReplyText(shelf, vehicles), 'Read NAPA $300.00: 6 × Oil filter and 2 × Shop towels.');
});

test('the reading reply: long receipts, several trucks, office checks, unreadable photos', () => {
  const many = {
    status: 'review', vendor: 'MHC Kenworth', total: 1200,
    lines: [
      { text: 'Brake drum', qty: 2, kind: 'part', vehicleId: 'v24' },
      { text: 'Shoes kit', qty: 1, kind: 'part', vehicleId: 'v31' },
      { text: 'Seal', qty: 1, kind: 'part', vehicleId: 'v31' },
      { text: 'Core return', qty: 1, kind: 'credit', vehicleId: 'v31' },
    ],
  };
  assert.equal(readReplyText(many, vehicles), 'Read MHC Kenworth $1200.00: 2 × Brake drum, Shoes kit and 1 more for T-24 and T-31. The office will check part of it. Wrong truck? Reply with the truck number.');
  assert.match(readReplyText({ status: 'unreadable' }), /^That photo could not be read/);
  assert.match(readReplyText({ status: 'error' }), /clearer photo of the whole receipt\.$/);
  const huge = { status: 'read', vendor: 'X'.repeat(400), total: 1, lines: [] };
  assert.ok(readReplyText(huge).length <= 320);
});

test('sending asks the Twilio Function, and never throws', async () => {
  assert.deepEqual(await sendReadReply('r1', 'hi', { secret: '' }), { sent: false, why: 'no READ_REPLY_SECRET' });
  const calls = [];
  const ok = await sendReadReply('r1', 'hi', { secret: 's3', fetchFn: async (url, opts) => { calls.push([url, String(opts.body)]); return { ok: true, json: async () => ({ ok: true, sent: true }) }; } });
  assert.deepEqual(ok, { sent: true, why: null });
  assert.deepEqual(calls, [[READ_REPLY_URL, 'receiptId=r1&text=hi&secret=s3']]);
  const down = await sendReadReply('r1', 'hi', { secret: 's3', fetchFn: async () => { throw new Error('offline'); } });
  assert.deepEqual(down, { sent: false, why: 'offline' });
});

test('a payment screenshot names the app in the reading reply', () => {
  const shot = { status: 'read', vendor: "Juan's Truck Parts", total: 180, paidWith: 'cashapp', lines: [{ text: 'Starter', qty: 1, kind: 'part', vehicleId: 'v31' }] };
  assert.equal(readReplyText(shot, vehicles), "Read Juan's Truck Parts $180.00 (Cash App): Starter for T-31. Wrong truck? Reply with the truck number.");
});
