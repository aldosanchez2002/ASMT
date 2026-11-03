// The text a buyer gets back once their texted receipt is read: the store,
// the total, the items, and the truck when the receipt or a text named one
// (it never asks for one). The reader (scripts/read-receipts.mjs) builds it and hands it to
// the Twilio Function /receipt-read, which knows the sender's number (phone
// numbers live only in Twilio) and sends it. The wording follows the samples
// registered with the texting campaign (twilio/README.md).

export const READ_REPLY_URL = 'https://receipts-4564.twil.io/receipt-read';
const MAX_CHARS = 320;

// "HEADLIGHT ASSY LH Halogen, DOT approved" -> "HEADLIGHT ASSY LH Halogen"
const shortItem = (text = '') => {
  const first = String(text).split(/[,;(]/)[0].trim();
  return first.length > 32 ? `${first.slice(0, 32).replace(/\s+\S*$/, '')}…` : first;
};
const listText = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');
const money = (n) => `$${Number(n).toFixed(2)}`;

/**
 * @param receipt  what the reader saved: { status, vendor, total, lines }
 * @param vehicles [{ id, name }] to name the trucks the lines are tied to
 * @returns the text
 */
export function readReplyText(receipt, vehicles = []) {
  if (receipt.status === 'unreadable' || receipt.status === 'error') {
    return 'That photo could not be read. Please send a clearer photo of the whole receipt.';
  }
  const lines = receipt.lines ?? [];
  const nameOf = (id) => vehicles.find((v) => v.id === id)?.name ?? null;
  const trucks = [...new Set(lines.flatMap((l) => [nameOf(l.vehicleId), ...(l.for ?? []).map((u) => u.name)]).filter(Boolean))];
  const items = lines.filter((l) => l.kind !== 'credit').map((l) => `${Number(l.qty) > 1 ? `${l.qty} × ` : ''}${shortItem(l.text)}`);
  const shown = items.length > 2 ? [...items.slice(0, 2), `${items.length - 2} more`] : items;
  const what = [receipt.vendor || 'the receipt', receipt.total != null ? money(receipt.total) : null].filter(Boolean).join(' ');
  let text = `Read ${what}${shown.length ? `: ${listText(shown)}` : ''}${trucks.length ? ` for ${listText(trucks)}` : ''}.`;
  if (receipt.status === 'review') text += ' The office will check part of it.';
  if (trucks.length) text += ' Wrong truck? Reply with the truck number.';
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
}

// Asks the Twilio Function to text the sender. Never throws: a reply that
// can't be sent shouldn't stop the reading.
export async function sendReadReply(receiptId, text, { secret = process.env.READ_REPLY_SECRET, fetchFn = fetch } = {}) {
  if (!secret) return { sent: false, why: 'no READ_REPLY_SECRET' };
  try {
    const res = await fetchFn(READ_REPLY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ receiptId, text, secret }),
    });
    const body = await res.json().catch(() => ({}));
    return { sent: Boolean(body.sent), why: body.why ?? (res.ok ? null : `HTTP ${res.status}`) };
  } catch (err) {
    return { sent: false, why: err.message };
  }
}
