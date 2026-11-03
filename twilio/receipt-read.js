// Twilio Function: texts a buyer what was read from the receipt they texted.
//
// The "Read receipts" Action (scripts/read-receipts.mjs) posts here after it
// reads a texted receipt, with the receipt id and the text to send
// (scripts/receipt-reply.mjs builds it). The sender's number is looked up
// here, from ALLOWED_SENDERS by the receipt's uploadedBy name, so phone
// numbers stay in Twilio only. Each receipt gets one reply per reading
// (replySentAt; a truck correction clears it and the receipt is read again).
//
// Lives in Twilio (Functions & Assets, the same "receipts" service as
// whatsapp-receipt.js), path /receipt-read, visibility Public: GitHub calls
// it, and it answers only with the shared READ_REPLY_SECRET. Setup:
// twilio/README.md.
//
// Environment variables (shared with whatsapp-receipt.js, plus):
//   READ_REPLY_SECRET      a long random phrase, also the GitHub secret of the same name
//   MESSAGING_SERVICE_SID  the Messaging Service the texting campaign is on (MG…)

// "Maria:+19155551234,Aldo:+19155550000" -> Map("Maria" => "+19155551234")
function numbersByName(value = '') {
  const map = new Map();
  for (const entry of value.split(',')) {
    if (!entry.includes(':')) continue;
    const [name, phone] = entry.split(':');
    const digits = (phone ?? '').replace(/[^\d+]/g, '');
    if (name.trim() && digits) map.set(name.trim(), digits);
  }
  return map;
}

// Firestore REST values (same as scripts/firestore-rest.mjs).
function fromValue(v) {
  const [type, x] = Object.entries(v)[0];
  if (type === 'mapValue') return Object.fromEntries(Object.entries(x.fields ?? {}).map(([k, y]) => [k, fromValue(y)]));
  if (type === 'arrayValue') return (x.values ?? []).map(fromValue);
  if (type === 'integerValue') return Number(x);
  if (type === 'nullValue') return null;
  return x;
}

exports.handler = async (context, event, callback, { fetchFn = fetch, client } = {}) => {
  const res = new Twilio.Response();
  res.appendHeader('Content-Type', 'application/json');
  const reply = (status, body) => {
    res.setStatusCode(status);
    res.setBody(body);
    return callback(null, res);
  };
  if (!context.READ_REPLY_SECRET || event.secret !== context.READ_REPLY_SECRET) return reply(403, { ok: false });
  if (context.SMS_REPLIES !== 'yes') return reply(200, { ok: true, sent: false, why: 'texting is off (SMS_REPLIES)' });
  const text = String(event.text ?? '');
  if (!text.trim() || text.length > 320) return reply(400, { ok: false, why: 'no text, or too long' });

  const docs = `projects/${context.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const id = String(event.receiptId ?? '').replace(/[^A-Za-z0-9]/g, '');
  const got = id ? await fetchFn(`https://firestore.googleapis.com/v1/${docs}/receipts/${id}?key=${context.FIREBASE_API_KEY}`) : null;
  if (!got?.ok) return reply(404, { ok: false, why: 'no such receipt' });
  const receipt = fromValue({ mapValue: { fields: (await got.json()).fields ?? {} } });
  if (receipt.source !== 'sms') return reply(200, { ok: true, sent: false, why: 'not a texted receipt' });
  if (receipt.replySentAt) return reply(200, { ok: true, sent: false, why: 'already answered' });
  const to = numbersByName(context.ALLOWED_SENDERS).get(receipt.uploadedBy ?? '');
  if (!to) return reply(200, { ok: true, sent: false, why: 'sender not in ALLOWED_SENDERS' });

  try {
    await (client ?? context.getTwilioClient()).messages.create({ messagingServiceSid: context.MESSAGING_SERVICE_SID, to, body: text });
  } catch (err) {
    // 21610: they texted STOP. Twilio won't deliver, and that's their choice.
    console.error(`receipt ${id}: ${err.code ?? ''} ${err.message}`);
    return reply(200, { ok: true, sent: false, why: err.code === 21610 ? 'opted out' : `Twilio ${err.code ?? 'error'}` });
  }
  await fetchFn(`https://firestore.googleapis.com/v1/${docs}:commit?key=${context.FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [{
        update: { name: `${docs}/receipts/${id}`, fields: { replySentAt: { timestampValue: new Date().toISOString() } } },
        updateMask: { fieldPaths: ['replySentAt'] },
      }],
    }),
  }).catch((err) => console.error(`receipt ${id}: could not mark the reply: ${err.message}`));
  return reply(200, { ok: true, sent: true });
};

// For the tests (test/receipt-read.test.mjs); Twilio only calls handler.
exports.numbersByName = numbersByName;
