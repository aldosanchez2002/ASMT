import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Twilio Functions provide a global `Twilio`; a stand-in Response that records what was set.
globalThis.Twilio = {
  ...globalThis.Twilio,
  Response: class {
    constructor() { this.headers = {}; this.status = 200; this.body = null; }
    appendHeader(k, v) { this.headers[k] = v; }
    setStatusCode(s) { this.status = s; }
    setBody(b) { this.body = b; }
  },
};
const fn = createRequire(import.meta.url)('../twilio/start-matching.js');

const run = (context, event, ok = true) => {
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push([url, opts.headers.Authorization, JSON.parse(opts.body)]); return { ok, status: ok ? 204 : 401 }; };
  return new Promise((resolve) => fn.handler(context, event, (err, res) => resolve({ res, calls }), { fetchFn }));
};

test('the app\'s ping starts the Read receipts run', async () => {
  const { res, calls } = await run({ GITHUB_TOKEN: 'gh' }, { app: 'aslog' });
  assert.deepEqual(calls, [['https://api.github.com/repos/aldosanchez2002/ASMT/actions/workflows/read-receipts.yml/dispatches', 'Bearer gh', { ref: 'main' }]]);
  assert.deepEqual([res.status, res.body, res.headers['Access-Control-Allow-Origin']], [200, { ok: true }, 'https://aslog.dev']);
});

test('anything else, no token, or GitHub saying no starts nothing or says so', async () => {
  assert.deepEqual((await run({ GITHUB_TOKEN: 'gh' }, {})).calls, []);
  assert.equal((await run({}, { app: 'aslog' })).res.status, 503);
  assert.deepEqual((await run({ GITHUB_TOKEN: 'bad' }, { app: 'aslog' }, false)).res.body, { ok: false });
});
