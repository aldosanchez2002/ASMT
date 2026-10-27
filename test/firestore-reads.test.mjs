import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuredQuery } from '../scripts/firestore-rest.mjs';
import { changedSince } from '../scripts/match-items.mjs';

test('queries ask Firestore for only the matching documents', () => {
  assert.deepEqual(structuredQuery('receipts', [['status', '==', 'waiting']]), {
    structuredQuery: {
      from: [{ collectionId: 'receipts' }],
      where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'waiting' } } },
    },
  });
  const q = structuredQuery('itemUses', [['createdAt', '>=', new Date('2026-06-01T00:00:00Z')], ['status', 'in', ['auto', 'doubt']]], { orderBy: ['createdAt', 'DESCENDING'], limit: 5 }).structuredQuery;
  assert.deepEqual(q.where.compositeFilter.filters.map((f) => [f.fieldFilter.op, f.fieldFilter.value]), [
    ['GREATER_THAN_OR_EQUAL', { timestampValue: '2026-06-01T00:00:00.000Z' }],
    ['IN', { arrayValue: { values: [{ stringValue: 'auto' }, { stringValue: 'doubt' }] } }],
  ]);
  assert.deepEqual([q.orderBy, q.limit], [[{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }], 5]);
});

test('the matcher stops after a few reads when nothing is new', async () => {
  const asked = [];
  const none = async (collection, filters, opts) => { asked.push([collection, filters[0][0], filters[0][1], typeof filters[0][2], opts.limit]); return []; };
  assert.equal(await changedSince('2026-10-27T05:00:00.000Z', none), null);
  assert.equal(asked.length, 6);
  assert.deepEqual(asked[0], ['serviceLog', 'loggedAt', '>', 'object', 1]); // a timestamp
  assert.deepEqual(asked[2], ['receipts', 'readAt', '>', 'string', 1]); // readAt is saved as text
  const newRead = async (collection, filters) => (collection === 'receipts' && filters[0][0] === 'readAt' ? [{ id: 'r1' }] : []);
  assert.equal(await changedSince('2026-10-27T05:00:00.000Z', newRead), 'receipts.readAt');
});
