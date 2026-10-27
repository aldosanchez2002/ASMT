// Twilio Function: receipts sent by WhatsApp.
//
// The buyer sends a photo of a receipt to the company's WhatsApp number
// (optionally with the truck, like "T-28"). This saves each photo as a
// receipt "waiting to be read", the same as "Upload receipts" in the app, and
// replies so the buyer knows it arrived. The "Read receipts" GitHub Action
// reads it from there.
//
// Lives in Twilio (Functions & Assets), not on the website; this copy is kept
// here so changes are tracked. Setup: twilio/README.md.
//
// Environment variables (Twilio Functions → Environment Variables):
//   ALLOWED_SENDERS     who may send receipts: "Maria:+19155551234,Aldo:+19155550000"
//   FIREBASE_PROJECT_ID aslogdev-a7225
//   FIREBASE_API_KEY    the web API key from web/firebase-config.js (not a secret)
// Dependency (Functions → Dependencies): jimp 0.22.12, to shrink large photos.

const MAX_PHOTO_CHARS = 700000; // a Firestore document holds up to ~1 MB
const TIME_ZONE = 'America/Denver'; // El Paso

// "Maria:+19155551234,Aldo:+19155550000" -> Map(+19155551234 => "Maria")
function parseSenders(value = '') {
  const map = new Map();
  for (const entry of value.split(',')) {
    const [name, phone] = entry.includes(':') ? entry.split(':') : ['', entry];
    const digits = (phone ?? '').replace(/[^\d+]/g, '');
    if (digits) map.set(digits, name.trim() || null);
  }
  return map;
}

// "t28", "T-28", "truck 28" in the message -> "T-28"
function truckFrom(text = '') {
  const m = text.match(/\b(?:t|truck)\s*-?\s*(\d{1,3})\b/i);
  return m ? `T-${m[1].padStart(2, '0')}` : null;
}

// Firestore REST value format (same as scripts/firestore-rest.mjs).
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Number.isInteger(v)) return { integerValue: String(v) };
  if (typeof v === 'number') return { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}
const toFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toValue(v)]));

const newId = () => Array.from({ length: 20 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');

// The photo as a data URL small enough for Firestore (shrunk with jimp when needed).
async function photoDataUrl(buffer, contentType) {
  const raw = `data:${contentType};base64,${buffer.toString('base64')}`;
  if (raw.length <= MAX_PHOTO_CHARS) return raw;
  const Jimp = require('jimp');
  const img = await Jimp.read(buffer);
  for (const [size, quality] of [[1600, 70], [1400, 60], [1200, 50]]) {
    img.scaleToFit(size, size).quality(quality);
    const url = `data:image/jpeg;base64,${(await img.getBufferAsync(Jimp.MIME_JPEG)).toString('base64')}`;
    if (url.length <= MAX_PHOTO_CHARS) return url;
  }
  throw new Error('photo too large');
}

// One receipt and its photo, written together.
async function saveReceipt(context, { photo, uploadedBy, truck, fetchFn }) {
  const id = newId();
  const docs = `projects/${context.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const receipt = {
    id, status: 'waiting', date: new Date().toLocaleDateString('en-CA', { timeZone: TIME_ZONE }),
    vendor: '', lines: [], tax: null, total: null, hasPhoto: true, uploadedBy, truckHint: truck, source: 'whatsapp',
  };
  const res = await fetchFn(`https://firestore.googleapis.com/v1/${docs}:commit?key=${context.FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        { update: { name: `${docs}/receipts/${id}`, fields: toFields(receipt) }, updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }] },
        { update: { name: `${docs}/receiptPhotos/${id}`, fields: toFields({ data: photo }) } },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Firestore ${res.status}: ${await res.text()}`);
  return id;
}

exports.handler = async (context, event, callback, { fetchFn = fetch } = {}) => {
  const twiml = new Twilio.twiml.MessagingResponse();
  const from = String(event.From ?? '').replace(/^whatsapp:/, '');
  const senders = parseSenders(context.ALLOWED_SENDERS);
  // Not the buyer (or anyone allowed): no answer at all.
  if (!senders.has(from)) return callback(null, new Twilio.twiml.MessagingResponse());

  const count = Number(event.NumMedia ?? 0);
  const truck = truckFrom(event.Body);
  if (!count) {
    twiml.message('Send a photo of the receipt. If the parts were for one truck, add its number, like T-28.');
    return callback(null, twiml);
  }
  let saved = 0;
  let skipped = 0;
  for (let i = 0; i < count; i += 1) {
    const type = event[`MediaContentType${i}`] ?? '';
    if (!type.startsWith('image/')) { skipped += 1; continue; }
    try {
      // Twilio's media links may require the account's credentials.
      const auth = Buffer.from(`${context.ACCOUNT_SID}:${context.AUTH_TOKEN}`).toString('base64');
      const media = await fetchFn(event[`MediaUrl${i}`], { headers: { Authorization: `Basic ${auth}` } });
      if (!media.ok) throw new Error(`media ${media.status}`);
      const photo = await photoDataUrl(Buffer.from(await media.arrayBuffer()), type);
      await saveReceipt(context, { photo, uploadedBy: senders.get(from), truck, fetchFn });
      saved += 1;
    } catch (err) {
      console.error(`receipt ${i + 1}: ${err.message}`);
      skipped += 1;
    }
  }
  const what = saved === 1 ? '1 receipt' : `${saved} receipts`;
  twiml.message(saved
    ? `Got it: ${what}${truck ? ` for ${truck}` : ''}. It will be read automatically.${skipped ? ` ${skipped} could not be saved; please send it again.` : ''}`
    : 'That photo could not be saved. Please send it again.');
  return callback(null, twiml);
};

// For the tests (twilio/whatsapp-receipt.test.mjs); Twilio only calls handler.
exports.parseSenders = parseSenders;
exports.truckFrom = truckFrom;
