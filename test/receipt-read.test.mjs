import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Twilio Functions provide a global `Twilio`; a stand-in for its Response.
globalThis.Twilio = {
  Response: class {
    constructor() { this.headers = {}; }
    appendHeader(k, v) { this.headers[k] = v; }
    setStatusCode(c) { this.statusCode = c; }
    setBody(b) { this.body = b; }
  },
};
const fn = createRequire(import.meta.url)('../twilio/receipt-read.js');

const context = {
  READ_REPLY_SECRET: 's3', SMS_REPLIES: 'yes', MESSAGING_SERVICE_SID: 'MG1', FIREBASE_PROJECT_ID: 'proj', FIREBASE_API_KEY: 'key',
  ALLOWED_SENDERS: 'Maria:+19155551234, Aldo:+19155550000',
};
const fields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? { nullValue: null } : { stringValue: v }]));
const run = (event, { receipt = { source: 'sms', uploadedBy: 'Maria' }, ctx = context, sendError = null } = {}) => {
  const sent = [];
  const writes = [];
  const client = { messages: { create: async (m) => { if (sendError) throw sendError; sent.push(m); } } };
  const fetchFn = async (url, opts = {}) => {
    if (opts.method === 'POST') { writes.push(JSON.parse(opts.body).writes); return { ok: true }; }
    return receipt ? { ok: true, json: async () => ({ fields: fields(receipt) }) } : { ok: false, status: 404 };
  };
  return new Promise((resolve) => fn.handler(ctx, event, (err, res) => resolve({ res, sent, writes }), { fetchFn, client }));
};
const good = { secret: 's3', receiptId: 'abc123', text: 'aslog: Read FleetPride $12.40: Oil filter for T-24. Wrong truck? Reply with the truck number.' };

test('names map to numbers; phone numbers come only from ALLOWED_SENDERS', () => {
  assert.deepEqual([...fn.numbersByName(context.ALLOWED_SENDERS)], [['Maria', '+19155551234'], ['Aldo', '+19155550000']]);
});

test('the reply goes to the receipt\'s sender once, from the campaign\'s Messaging Service', async () => {
  const { res, sent, writes } = await run(good);
  assert.deepEqual([res.statusCode, res.body], [200, { ok: true, sent: true }]);
  assert.deepEqual(sent, [{ messagingServiceSid: 'MG1', to: '+19155551234', body: good.text }]);
  assert.deepEqual(writes[0][0].updateMask, { fieldPaths: ['replySentAt'] });
  assert.match(writes[0][0].update.name, /receipts\/abc123$/);
  const again = await run(good, { receipt: { source: 'sms', uploadedBy: 'Maria', replySentAt: '2026-11-03T07:22:30Z' } });
  assert.deepEqual([again.sent.length, again.res.body.why], [0, 'already answered']);
});

test('nothing is sent without the secret, with texting off, or for odd requests', async () => {
  assert.equal((await run({ ...good, secret: 'nope' })).res.statusCode, 403);
  assert.equal((await run(good, { ctx: { ...context, READ_REPLY_SECRET: '' } })).res.statusCode, 403);
  const off = await run(good, { ctx: { ...context, SMS_REPLIES: '' } });
  assert.deepEqual([off.sent.length, off.res.body.why], [0, 'texting is off (SMS_REPLIES)']);
  assert.equal((await run({ ...good, text: 'Buy now!' })).res.statusCode, 400);
  assert.equal((await run(good, { receipt: null })).res.statusCode, 404);
  assert.equal((await run(good, { receipt: { source: 'whatsapp', uploadedBy: 'Maria' } })).res.body.why, 'not a texted receipt');
  assert.equal((await run(good, { receipt: { source: 'sms', uploadedBy: 'Stranger' } })).res.body.why, 'sender not in ALLOWED_SENDERS');
});

test('someone who texted STOP isn\'t texted, and isn\'t marked as answered', async () => {
  const stopped = await run(good, { sendError: Object.assign(new Error('unsubscribed'), { code: 21610 }) });
  assert.deepEqual([stopped.res.body, stopped.writes.length], [{ ok: true, sent: false, why: 'opted out' }, 0]);
});
