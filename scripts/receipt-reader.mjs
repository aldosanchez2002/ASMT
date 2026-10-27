// Reading a receipt photo: what Claude is asked, the shape it must answer in,
// and how its answer becomes a receipt. Claude only reads, matches and sorts;
// this file decides what counts (sure matches go on the shelf, repair parts
// go to the pool for the matcher), works out each line's real cost with its
// share of tax and fees, and checks the math. No network here, so it's tested.

import { POOL_KINDS, SHOP_KINDS, landedCosts } from '../web/items.js';

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

// The answer's shape (structured outputs: Claude can't return anything else).
export const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readable', 'problem', 'vendor', 'date', 'invoiceNumber', 'noteTrucks', 'lines', 'fees', 'tax', 'total'],
  properties: {
    readable: { type: 'boolean', description: 'false if the photo is too blurry, dark or cut off to read the items and total' },
    problem: { ...nullable('string'), description: 'what is wrong with the photo, if anything' },
    vendor: { ...nullable('string'), description: 'store name as printed' },
    date: { ...nullable('string'), description: 'purchase date, YYYY-MM-DD' },
    invoiceNumber: nullable('string'),
    noteTrucks: { type: 'array', items: { type: 'string' }, description: "every truck number the buyer's note mentions, from the truck list" },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['printed', 'partNumber', 'quantity', 'unitPrice', 'lineTotal', 'kind', 'matchPartId', 'matchSure', 'matchReason', 'stockQuantity', 'truck', 'truckSource'],
        properties: {
          printed: { type: 'string', description: 'the item text as printed' },
          partNumber: { ...nullable('string'), description: 'the part number, without a store or location prefix' },
          quantity: { type: 'number', description: 'quantity as printed' },
          unitPrice: nullable('number'),
          lineTotal: { ...nullable('number'), description: 'the line amount as printed, before tax (negative for a return or credit)' },
          kind: { type: 'string', enum: ['part', 'labor', 'core', 'supplies', 'tool', 'credit'], description: 'what the item is (a stock list part is "part")' },
          matchPartId: { ...nullable('string'), description: 'id from the stock list, or null if none fits' },
          matchSure: { type: 'boolean', description: 'true only if the part number or an exact name/cross-reference identifies it' },
          matchReason: { type: 'string' },
          stockQuantity: { ...nullable('number'), description: "quantity in the matched part's counting unit (gallons for oil: 1 drum = its gallons)" },
          truck: { ...nullable('string'), description: 'truck number from the truck list this item is for, or null if nothing says' },
          truckSource: { anyOf: [{ type: 'string', enum: ['printed', 'handwritten', 'note'] }, { type: 'null' }], description: 'what tied the item to the truck' },
        },
      },
    },
    fees: {
      type: 'array',
      description: 'charges that are not items: card fees, surcharges, shipping, freight, environmental or shop fees',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'amount'],
        properties: { label: { type: 'string', description: 'as printed' }, amount: { type: 'number' } },
      },
    },
    tax: nullable('number'),
    total: { ...nullable('number'), description: 'the total paid' },
  },
};

export const SYSTEM_PROMPT = `You read parts-store receipts for a trucking company's shop and sort every item.

Read only what is printed. Never guess a price, quantity or part number; use null when something isn't there or can't be read. If the photo can't be read well enough to get the items and the total, set readable to false and say why in problem.

Each item gets a kind:
- part: a part for a truck or trailer (filters, brake drums, sensors, lights, hoses, tires, batteries, oil).
- labor: labor or a service done by the store or another shop.
- core: a core charge or core deposit.
- supplies: shop supplies used up across the fleet (cleaners, degreaser, rags, gloves, grease, shop towels, zip ties).
- tool: a tool or shop equipment.
- credit: a return or credit (negative amount).
Card fees, surcharges, shipping, freight, environmental and shop fees are not items: put them in fees, with the amount as printed. Do not list subtotal, tax or total lines as items or fees.

Part numbers: some stores print a location or store prefix before the part number, like "104F/DB1655B" or "WAB 432..." for a brand code; give the part number itself ("DB1655B").

For each part, find the stock list part it is, using the part number first (including the cross-reference numbers listed with each part), then the description. Set matchSure to true only when the part number or an unmistakable description identifies it; when it's only a likely guess, give the id but set matchSure to false. Items that aren't on the stock list get matchPartId null. For a matched part counted in gallons, give stockQuantity in gallons (a 55 gal drum bought once is 55).

Which truck each item is for: one receipt often has parts for several trucks. Set truck (a name from the truck list) only when something says so, and set truckSource to what said it:
- printed: the receipt prints a unit number, truck ID or VIN for the item (or for the whole receipt).
- handwritten: a truck number is written by hand next to the item (or across the whole receipt).
- note: the buyer's note ties it to a truck. A note naming one truck and nothing else means every item is for that truck. A note like "28 drums, 31 headlight" ties items by what they are. Bare numbers in a note are truck numbers (28 = T-28).
List every truck the note mentions in noteTrucks. If nothing says which truck an item is for, leave truck null: it's matched to the work later.`;

// The text that goes with the photo: the stock list, the trucks, what the AI
// has been taught (ai-memory.mjs), and the note the buyer sent (if any).
export function contextText(parts, vehicles, note = null, memory = '') {
  const stock = parts.filter((p) => !p.archived).map((p) => {
    const packs = (p.packs ?? []).map((x) => `${x.name} = ${x.size} ${p.unit === 'gal' ? 'gal' : 'pcs'}`).join(', ');
    return `- id ${p.id}: ${p.name}${p.number ? ` | numbers: ${p.number}` : ''} | counted in ${p.unit === 'gal' ? 'gallons' : 'pieces'}${packs ? ` | sold as ${packs}` : ''}`;
  });
  const trucks = vehicles.filter((v) => v.name).map((v) => `- ${v.name}${v.vin ? ` VIN ${v.vin}` : ''}`);
  const memoryPart = memory ? `\n\n${memory}` : '';
  const noteText = note ? `\n\nThe buyer's note sent with the photo: "${note.replace(/\s+/g, ' ')}"` : '';
  return `Stock list:\n${stock.join('\n')}\n\nTrucks:\n${trucks.join('\n')}${memoryPart}${noteText}\n\nRead the receipt in the photo.`;
}

const round2 = (n) => Math.round(n * 100) / 100;
const newLineId = () => Math.random().toString(36).slice(2, 10);
const invoiceKey = (n) => String(n ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Claude's reading -> the fields saved on the receipt.
 * Sure matches go on the shelf (`part` set), noting the truck they were bought
 * for. Repair parts, labor and cores go to their truck if something says
 * which, else to the pool, where the matcher ties them to the work. Shop
 * supplies and tools go to the shop. Unsure stock matches, unclear
 * quantities and missing prices are flagged and wait for a person; so does
 * a total that doesn't add up, or an invoice already uploaded.
 * `trucks` are the trucks the WhatsApp note named: when it named only one,
 * every item is for it; when it named several, items with no truck keep
 * those as the matcher's only choices.
 * `others`: the other receipts, to catch the same invoice uploaded twice.
 * @returns { status: 'read'|'review'|'unreadable', vendor, date,
 *   invoiceNumber, lines, fees, feesTotal, tax, total, problems }
 */
export function receiptFromReading(reading, parts, vehicles, { uploadedDate, trucks = [], others = [], newId = newLineId } = {}) {
  const partById = new Map(parts.map((p) => [p.id, p]));
  const truckByName = new Map(vehicles.map((v) => [String(v.name ?? '').toUpperCase(), v]));
  const truckNamed = (name) => truckByName.get(String(name ?? '').toUpperCase()) ?? null;
  // The trucks the note named, by the Function or by the reader.
  const noted = [...new Set([...trucks, ...(reading.noteTrucks ?? [])].map(truckNamed).filter(Boolean))];
  // A receipt can't be from after its upload: a later date is a misread.
  const misdated = Boolean(reading.date && uploadedDate && reading.date > uploadedDate);
  const base = { vendor: reading.vendor ?? '', date: (misdated ? null : reading.date) ?? uploadedDate ?? null, invoiceNumber: reading.invoiceNumber ?? null };
  if (!reading.readable) {
    return { ...base, status: 'unreadable', lines: [], fees: [], feesTotal: 0, tax: null, total: null, problems: [reading.problem || 'The photo could not be read'] };
  }
  const lines = reading.lines.map((l) => {
    const part = l.matchPartId ? partById.get(l.matchPartId) : null;
    const sure = Boolean(part && l.matchSure);
    const truck = truckNamed(l.truck) ?? (noted.length === 1 ? noted[0] : null);
    const price = l.lineTotal ?? (l.unitPrice != null ? round2(l.unitPrice * l.quantity) : null);
    // Gallons for oil (a drum is its size), pieces for everything else.
    const qty = sure && part.unit === 'gal' ? l.stockQuantity : l.quantity;
    const flags = [];
    if (part && !sure) flags.push('unsure');
    if (sure && part.unit === 'gal' && !(l.stockQuantity > 0)) flags.push('quantity');
    if (price == null) flags.push('noPrice');
    const counts = sure && !flags.includes('quantity');
    const kind = counts ? 'stock' : l.kind === 'credit' || (price != null && price < 0) ? 'credit' : l.kind;
    const pool = POOL_KINDS.includes(kind) && !(part && !counts);
    return {
      id: newId(),
      part: counts ? part.id : null,
      suggestedPart: part && !counts ? part.id : null,
      kind,
      text: l.printed,
      partNumber: l.partNumber ?? null,
      qty: qty ?? l.quantity,
      price,
      to: counts ? 'stock' : SHOP_KINDS.includes(kind) ? 'shop' : truck && (pool || kind === 'credit') ? 'truck' : null,
      vehicleId: truck && !counts && (pool || kind === 'credit') ? truck.id : null,
      for: truck && counts ? [{ id: truck.id, name: truck.name }] : null,
      truckFrom: truck && !SHOP_KINDS.includes(kind) ? (truckNamed(l.truck) ? l.truckSource ?? null : 'note') : null,
      truckChoices: !truck && noted.length > 1 && pool ? noted.map((v) => v.id) : null,
      flags,
      matchReason: l.matchReason,
    };
  });
  const fees = (reading.fees ?? []).filter((f) => Number(f.amount)).map((f) => ({ label: f.label, amount: round2(Number(f.amount)) }));
  const feesTotal = round2(fees.reduce((s, f) => s + f.amount, 0));
  const tax = reading.tax ?? null;
  const costs = landedCosts(lines, (tax ?? 0) + feesTotal);
  lines.forEach((l, i) => { l.cost = costs[i]; });

  const problems = [];
  const sum = round2(lines.reduce((s, l) => s + (l.price ?? 0), 0) + (tax ?? 0) + feesTotal);
  if (reading.total != null && lines.every((l) => l.price != null) && Math.abs(sum - reading.total) > 0.05) {
    problems.push(`Items, tax and fees come to $${sum.toFixed(2)}, but the receipt total is $${reading.total.toFixed(2)}`);
  }
  if (!lines.length) problems.push('No items were found on the receipt');
  if (misdated) problems.push(`The date was read as ${reading.date}, after the upload; check it`);
  const key = invoiceKey(base.invoiceNumber);
  const twin = key && others.find((o) => invoiceKey(o.invoiceNumber) === key && (!o.vendor || !base.vendor || o.vendor.toLowerCase() === base.vendor.toLowerCase()));
  if (twin) problems.push(`Invoice ${base.invoiceNumber} was already uploaded${twin.date ? ` (${twin.date})` : ''}; it may be the same receipt twice`);
  const status = problems.length || lines.some((l) => l.flags.length) ? 'review' : 'read';
  return { ...base, status, lines, fees, feesTotal, tax, total: reading.total ?? (lines.length ? sum : null), problems };
}
