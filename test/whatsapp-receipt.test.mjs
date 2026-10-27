import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Twilio Functions provide a global `Twilio`; a stand-in that records replies.
globalThis.Twilio = {
  twiml: {
    MessagingResponse: class {
      constructor() { this.messages = []; }
      message(text) { this.messages.push(text); }
    },
  },
};
const fn = createRequire(import.meta.url)('../twilio/whatsapp-receipt.js');

const context = {
  ALLOWED_SENDERS: 'Maria:+19155551234, Aldo:+19155550000', FIREBASE_PROJECT_ID: 'proj', FIREBASE_API_KEY: 'key', ACCOUNT_SID: 'AC1', AUTH_TOKEN: 'tok',
};
const run = (event) => {
  const writes = [];
  const fetchFn = async (url, opts = {}) => {
    if (url.startsWith('https://media')) return { ok: true, arrayBuffer: async () => Buffer.from('jpegbytes') };
    writes.push(JSON.parse(opts.body).writes);
    return { ok: true };
  };
  return new Promise((resolve) => {
    fn.handler(context, event, (err, twiml) => resolve({ twiml, writes }), { fetchFn });
  });
};

test('senders and truck numbers are read from settings and messages', () => {
  assert.deepEqual([...fn.parseSenders(context.ALLOWED_SENDERS)], [['+19155551234', 'Maria'], ['+19155550000', 'Aldo']]);
  assert.deepEqual(fn.trucksFrom('for t28 please'), ['T-28']);
  assert.deepEqual(fn.trucksFrom('Truck 7'), ['T-07']);
  assert.deepEqual(fn.trucksFrom('T-104'), ['T-104']);
  assert.deepEqual(fn.trucksFrom('T-28 drums, t31 headlight, T28 seal'), ['T-28', 'T-31']);
  assert.deepEqual(fn.trucksFrom('balatas camión 9 y unidad 12'), ['T-09', 'T-12']);
  assert.deepEqual(fn.trucksFrom('two filters, 28 y 31'), []);
  assert.deepEqual(fn.trucksFrom('cat 5w-40 tt2'), []);
});

test('a photo from the buyer becomes a waiting receipt, with the truck', async () => {
  const { twiml, writes } = await run({
    From: 'whatsapp:+19155551234', Body: 'T-28', NumMedia: '1', MediaUrl0: 'https://media/1', MediaContentType0: 'image/jpeg',
  });
  assert.equal(writes.length, 1);
  const [receipt, photo] = writes[0];
  assert.match(receipt.update.name, /receipts\/\w{20}$/);
  const f = receipt.update.fields;
  assert.deepEqual([f.status.stringValue, f.uploadedBy.stringValue, f.note.stringValue, f.source.stringValue, f.hasPhoto.booleanValue], ['waiting', 'Maria', 'T-28', 'whatsapp', true]);
  assert.deepEqual(f.trucks.arrayValue.values, [{ stringValue: 'T-28' }]);
  assert.deepEqual(receipt.updateTransforms, [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }]);
  assert.equal(photo.update.fields.data.stringValue, `data:image/jpeg;base64,${Buffer.from('jpegbytes').toString('base64')}`);
  assert.deepEqual(twiml.messages, ['Got it: 1 receipt for T-28. It will be read automatically.']);
});

test('a note naming several trucks is saved whole, and the reply names them', async () => {
  const { twiml, writes } = await run({
    From: 'whatsapp:+19155551234', Body: ' T-28 drums, T-31 headlight ', NumMedia: '1', MediaUrl0: 'https://media/1', MediaContentType0: 'image/jpeg',
  });
  const f = writes[0][0].update.fields;
  assert.equal(f.note.stringValue, 'T-28 drums, T-31 headlight');
  assert.deepEqual(twiml.messages, ['Got it: 1 receipt for T-28 and T-31. It will be read automatically.']);
});

test('several photos become several receipts; non-images are skipped', async () => {
  const { twiml, writes } = await run({
    From: 'whatsapp:+19155550000', NumMedia: '3',
    MediaUrl0: 'https://media/1', MediaContentType0: 'image/jpeg',
    MediaUrl1: 'https://media/2', MediaContentType1: 'image/png',
    MediaUrl2: 'https://media/3', MediaContentType2: 'audio/ogg',
  });
  assert.equal(writes.length, 2);
  assert.match(twiml.messages[0], /^Got it: 2 receipts\. .* 1 could not be saved/);
});

test('an iPhone .heic file is not saved, and the reply says to send it as a photo', async () => {
  const heic = await run({ From: 'whatsapp:+19155551234', NumMedia: '1', MediaUrl0: 'https://media/1', MediaContentType0: 'image/heic' });
  assert.equal(heic.writes.length, 0);
  assert.deepEqual(heic.twiml.messages, ["That was sent as a file (like .heic) that can't be read. Send it as a photo instead: tap + then Photos, not Document."]);
  const mixed = await run({
    From: 'whatsapp:+19155551234', NumMedia: '2',
    MediaUrl0: 'https://media/1', MediaContentType0: 'image/jpeg',
    MediaUrl1: 'https://media/2', MediaContentType1: 'image/heic',
  });
  assert.equal(mixed.writes.length, 1);
  assert.match(mixed.twiml.messages[0], /^Got it: 1 receipt\. .* 1 was a file \(like \.heic\)/);
});

test('strangers get no answer; a text without a photo gets a hint', async () => {
  const stranger = await run({ From: 'whatsapp:+12125550000', NumMedia: '1', MediaUrl0: 'https://media/1', MediaContentType0: 'image/jpeg' });
  assert.deepEqual([stranger.writes.length, stranger.twiml.messages.length], [0, 0]);
  const hint = await run({ From: 'whatsapp:+19155551234', Body: 'hi', NumMedia: '0' });
  assert.match(hint.twiml.messages[0], /Send a photo of the receipt/);
});
