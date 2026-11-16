import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samsaraAccounts, samsaraGetAllAccounts } from '../scripts/samsara.mjs';

test('the accounts come from SAMSARA_API_KEY, then _2…_5, skipping blanks', () => {
  assert.deepEqual(samsaraAccounts({ SAMSARA_API_KEY: 'a', SAMSARA_API_KEY_2: ' b ', SAMSARA_API_KEY_3: '' }), [{ n: 1, key: 'a' }, { n: 2, key: 'b' }]);
  assert.deepEqual(samsaraAccounts({ SAMSARA_API_KEY: 'a' }), [{ n: 1, key: 'a' }]);
});

const accounts = [{ n: 1, key: 'a' }, { n: 2, key: 'b' }];
const quiet = (fn) => async () => {
  const warn = console.warn;
  console.warn = () => {};
  try { await fn(); } finally { console.warn = warn; }
};

test('both fleets merge into one list, each unit tagged with its account', async () => {
  const get = async (_path, _params, key) => (key === 'a' ? [{ id: '1', name: 'T-01' }] : [{ id: '9', name: 'T-90' }]);
  assert.deepEqual(await samsaraGetAllAccounts('/fleet/vehicles', {}, { accounts, get }), [
    { id: '1', name: 'T-01', _account: 1 }, { id: '9', name: 'T-90', _account: 2 },
  ]);
});

test('a failing second account is skipped; a failing main account still fails', quiet(async () => {
  const second = async (_p, _q, key) => { if (key === 'b') throw new Error('401'); return [{ id: '1' }]; };
  assert.deepEqual(await samsaraGetAllAccounts('/fleet/vehicles', {}, { accounts, get: second }), [{ id: '1', _account: 1 }]);
  const main = async (_p, _q, key) => { if (key === 'a') throw new Error('503'); return [{ id: '9' }]; };
  await assert.rejects(samsaraGetAllAccounts('/fleet/vehicles', {}, { accounts, get: main }), /503/);
}));
