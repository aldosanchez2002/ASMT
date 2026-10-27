// What the AI remembers between runs: the notes admin writes for it (AI
// matches → Notes for the AI, saved in meta/aiMemory) and admin's recent
// corrections (the corrections collection, written by the website whenever
// admin changes what the reader read or what the matcher matched). Both go
// into the prompts, so a mistake corrected once isn't made again.
//
// corrections docs:
//   { type: 'reading', at, vendor, text, partNumber, before, after }
//     before / after: { part, kind, truck, qty, price } — before null: the
//     reader missed the line; after null: the line wasn't on the receipt
//   { type: 'match', at, itemText, partNumber, vendor, itemDate, ai, admin }
//     ai: { repair, truck, date, confidence } or null (the AI found nothing)
//     admin: { repair, truck, date } | { truck } | { shop: true } | { shelf: true }

const MAX_EXAMPLES = 30;

const quote = (s) => `"${String(s ?? '').replace(/\s+/g, ' ').trim()}"`;
const money = (n) => (n == null ? null : `$${Number(n).toFixed(2)}`);

function placeText(x, partName) {
  if (!x) return null;
  if (x.part) return `stock part ${partName(x.part)}`;
  return [x.kind ?? 'part', x.truck ? `for ${x.truck}` : null, x.qty != null ? `qty ${x.qty}` : null, money(x.price)].filter(Boolean).join(', ');
}

function readingLine(c, partName) {
  const what = `${quote(c.text)}${c.partNumber ? ` (${c.partNumber})` : ''}${c.vendor ? ` at ${c.vendor}` : ''}`;
  if (!c.before) return `${what}: you missed this line; it was ${placeText(c.after, partName)}.`;
  if (!c.after) return `${what}: you read this line, but it isn't an item on the receipt.`;
  return `${what}: you said ${placeText(c.before, partName)}; it was ${placeText(c.after, partName)}.`;
}

function matchPlace(x) {
  if (!x) return 'no repair';
  if (x.shop) return 'shop supplies (not a repair part)';
  if (x.shelf) return 'still on the shelf (not used yet)';
  if (x.repair) return `the repair ${quote(x.repair)} on ${x.truck}${x.date ? ` (${x.date})` : ''}`;
  return `${x.truck}, with no repair recorded`;
}

function matchLine(c) {
  const what = `${quote(c.itemText)}${c.partNumber ? ` (${c.partNumber})` : ''} bought ${c.itemDate ?? '?'}${c.vendor ? ` at ${c.vendor}` : ''}`;
  return `${what}: you said ${matchPlace(c.ai)}; it was ${matchPlace(c.admin)}.`;
}

const newestFirst = (a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''));

/**
 * The memory section for one prompt.
 * @param type 'reading' | 'match'
 * @param memory meta/aiMemory doc ({ notes })
 * @param corrections corrections docs
 * @param parts the stock list (to name stock parts by name)
 * @returns text, or '' when there's nothing to remember
 */
export function memoryText(type, memory, corrections = [], parts = []) {
  const partName = (id) => parts.find((p) => p.id === id)?.name ?? id;
  const notes = String(memory?.notes ?? '').trim();
  const lines = corrections.filter((c) => c.type === type).sort(newestFirst).slice(0, MAX_EXAMPLES)
    .map((c) => `- ${type === 'reading' ? readingLine(c, partName) : matchLine(c)}`);
  const out = [];
  if (notes) out.push(`What the shop's admin has told you (follow it):\n${notes}`);
  if (lines.length) out.push(`Recent corrections by the shop's admin, most recent first. Learn from them and don't repeat the mistakes:\n${lines.join('\n')}`);
  return out.join('\n\n');
}
