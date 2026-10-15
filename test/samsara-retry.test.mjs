import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '../scripts/samsara.mjs';

const respond = (status) => new Response(status === 200 ? '{"data":[]}' : '{"message":"Gateway Timeout"}', { status });

test('retries a 504 and returns the next good answer', async (t) => {
  const answers = [504, 503, 200];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => respond(answers[calls++]));
  t.mock.method(console, 'warn', () => {});
  const res = await fetchWithRetry(new URL('https://api.samsara.com/fleet/trailers/stats'), {}, [0, 0, 0]);
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
});

test('gives up after the last retry and returns the error answer', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return respond(504); });
  t.mock.method(console, 'warn', () => {});
  const res = await fetchWithRetry(new URL('https://api.samsara.com/x'), {}, [0, 0]);
  assert.equal(res.status, 504);
  assert.equal(calls, 3);
});

test('does not retry a 401 (bad key)', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return respond(401); });
  const res = await fetchWithRetry(new URL('https://api.samsara.com/x'), {}, [0, 0]);
  assert.equal(res.status, 401);
  assert.equal(calls, 1);
});

test('retries a dropped connection', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; if (calls === 1) throw new Error('socket hang up'); return respond(200); });
  t.mock.method(console, 'warn', () => {});
  const res = await fetchWithRetry(new URL('https://api.samsara.com/x'), {}, [0]);
  assert.equal(res.status, 200);
});
