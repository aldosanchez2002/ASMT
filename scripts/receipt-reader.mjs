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
  required: ['readable', 'problem', 'document', 'forShop', 'paidWith', 'vendor', 'date', 'time', 'invoiceNumber', 'noteTrucks', 'lines', 'fees', 'tax', 'total'],
  properties: {
    readable: { type: 'boolean', description: 'false if the photo is too blurry, dark or cut off to read the items and total' },
    problem: { ...nullable('string'), description: 'what is wrong with the photo, if anything' },
    document: { type: 'string', enum: ['receipt', 'registration', 'inspection'], description: '"registration" for a vehicle registration, cab card or registration renewal; "inspection" for an annual/DOT inspection report or sticker; otherwise "receipt"' },
    forShop: { type: 'boolean', description: "true when the buyer's note says the whole purchase is for the shop (shop supplies, shop inventory, taller) and names no truck" },
    paidWith: { type: 'string', enum: ['receipt', 'cashapp', 'zelle', 'venmo', 'paypal', 'bank', 'other'], description: '"receipt" for a store receipt or invoice; otherwise the app or bank of a payment screenshot' },
    vendor: { ...nullable('string'), description: 'store name as printed' },
    date: { ...nullable('string'), description: 'purchase date, YYYY-MM-DD' },
    time: { ...nullable('string'), description: 'purchase time if printed, 24-hour HH:MM (11:43:50AM -> 11:43)' },
    invoiceNumber: nullable('string'),
    noteTrucks: { type: 'array', items: { type: 'string' }, description: "every truck number the buyer's note mentions, from the truck list" },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['printed', 'partNumber', 'quantity', 'unitPrice', 'lineTotal', 'kind', 'truck', 'truckSource'],
        properties: {
          printed: { type: 'string', description: 'the item text as printed' },
          partNumber: { ...nullable('string'), description: 'the part number, without a store or location prefix' },
          quantity: { type: 'number', description: 'quantity as printed' },
          unitPrice: nullable('number'),
          lineTotal: { ...nullable('number'), description: 'the line amount as printed, before tax (negative for a return or credit)' },
          kind: { type: 'string', enum: ['part', 'labor', 'core', 'fee', 'supplies', 'tool', 'credit'], description: 'what the item is' },
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

export const SYSTEM_PROMPT = `You read photos a trucking company's shop texts in, and sort them in this order.

0. Is the photo legible? Read only what is printed. Never guess a price, quantity or part number; use null when something isn't there or can't be read. If the photo can't be read well enough to get the items and the total, set readable to false, say why in problem, and stop.

1. Is it a registration? A vehicle registration, cab card or registration renewal: set document to "registration" (it is read again as that paper).
2. Is it an inspection? An annual/DOT inspection report or sticker: set document to "inspection" (it is read again as that paper).
3. Otherwise it is a receipt: document is "receipt". Read every item, then answer two questions:

3.1 Is it shared by the shop? Set forShop to true when the buyer's note says the purchase is for the shop ("shop", "shop supplies", "for the shop", "inventory", "taller", "inventario", "para el taller") and names no truck. Everything on such a receipt is a shop cost, whatever the items are. Items that are shop costs by nature are shared too, on any receipt: supplies (cleaners, degreaser, rags, gloves, shop towels, zip ties), fluids bought in bulk (oil, coolant, DEF, grease), and tools or shop equipment.
3.2 Is it for a specific service? Everything else is for a truck or trailer's service: set truck when something says which (below); if nothing says, leave it null and it's matched to the work later.

Each item gets a kind:
- part: a part for a truck or trailer (filters, brake drums, sensors, lights, hoses, tires, batteries, clamps).
- labor: labor or a service done by the store or another shop.
- core: a core charge or core deposit.
- fee: a charge that comes with an item, like a state battery fee, a tire fee, or a disposal or recycling fee for a part. It goes with that item (and its truck).
- supplies: shop supplies used up across the fleet, and fluids bought in bulk: engine oil, coolant or antifreeze, DEF, grease. (A part that holds or moves a fluid, like an oil filter, coolant hose or DEF pump, is a part.)
- tool: a tool or shop equipment.
- credit: a return or credit (negative amount).
Charges for the whole receipt (card fees, surcharges, shipping, freight, shop fees) are not items: put them in fees, with the amount as printed. Do not list subtotal, tax or total lines as items or fees.

Part numbers: some stores print a location or store prefix before the part number, like "104F/DB1655B" or "WAB 432..." for a brand code; give the part number itself ("DB1655B").

Which truck each item is for: one receipt often has parts for several trucks. Set truck (a name from the truck list) only when something says so, and set truckSource to what said it:
- printed: the receipt prints a unit number, truck ID or VIN for the item (or for the whole receipt).
- handwritten: a truck number is written by hand next to the item (or across the whole receipt).
- note: the buyer's note ties it to a truck. A note naming one truck and nothing else means every item is for that truck. A note like "28 drums, 31 headlight" ties items by what they are. Bare numbers in a note are truck numbers (28 = T-28).
List every truck the note mentions in noteTrucks.

Payment screenshots: sometimes the photo is not a store receipt but a screenshot of a payment (Cash App, Zelle, Venmo, PayPal, a bank transfer). Then set paidWith to that app (or "bank"), the vendor to who was paid, the date to the payment date, and the total to the amount paid. The items come from the buyer's note ("starter T-31" is one line: printed "Starter", quantity 1, lineTotal the amount paid, the truck from the note); with no note, make one line printed "Payment" for the amount. A payment screenshot has no tax or fees. For a store receipt, paidWith is "receipt".`;

// The text that goes with the photo: the trucks, what the AI
// has been taught (ai-memory.mjs), and the note the buyer sent (if any).
export function contextText(parts, vehicles, note = null, memory = '') {
  const trucks = vehicles.filter((v) => v.name).map((v) => `- ${v.name}${v.vin ? ` VIN ${v.vin}` : ''}`);
  const memoryPart = memory ? `\n\n${memory}` : '';
  const noteText = note ? `\n\nThe buyer's note sent with the photo: "${note.replace(/\s+/g, ' ')}"` : '';
  return `Trucks:\n${trucks.join('\n')}${memoryPart}${noteText}\n\nRead the receipt in the photo.`;
}

const round2 = (n) => Math.round(n * 100) / 100;
// A note saying the purchase is for the shop.
export const shopNote = (note) => /(?<![\p{L}\d])(shop|taller|inventory|inventario|supplies|suministros)(?![\p{L}\d])/iu.test(note ?? '');
// A fluid bought in bulk, not a part that holds or moves one ("OIL FILTER", "COOLANT HOSE").
const FLUID = /(?<![\p{L}\d])(oil|motor oil|engine oil|coolant|antifreeze|def|diesel exhaust fluid|grease|lubricant|aceite|anticongelante|rotella|delo|delvac|\d{1,2}w-?\d{2})(?![\p{L}\d])/iu;
const FLUID_PART = /(?<![\p{L}\d])(filters?|fltr|seals?|pans?|coolers?|pumps?|caps?|gaskets?|hoses?|sensors?|lines?|tanks?|heaters?|plugs?|pressure|level|valves?|guns?)(?![\p{L}\d])/iu;
export const bulkFluid = (text = '') => FLUID.test(text) && !FLUID_PART.test(text);
const newLineId = () => Math.random().toString(36).slice(2, 10);
const invoiceKey = (n) => String(n ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Claude's reading -> the fields saved on the receipt.
 * Nothing goes on a shelf: parts are bought for the job. Repair parts
 * (filters, tires and batteries too), labor and cores go to their truck if
 * something says which, else to the pool, where the matcher ties them to the
 * work (repairs and services). Shop supplies, bulk fluids and tools go to the
 * shop, and so does everything on a receipt the note says is for the shop.
 * Missing prices are flagged and wait for a person; so does a total that
 * doesn't add up, or an invoice already uploaded.
 * `trucks` are the trucks the WhatsApp note named: when it named only one,
 * every item is for it; when it named several, items with no truck keep
 * those as the matcher's only choices.
 * `others`: the other receipts, to catch the same invoice uploaded twice.
 * @returns { status: 'read'|'review'|'unreadable', vendor, date, time
 *   (as printed, HH:MM, or null), invoiceNumber, lines, fees, feesTotal,
 *   tax, total, problems }
 */
export function receiptFromReading(reading, parts, vehicles, { uploadedDate, trucks = [], others = [], note = null, newId = newLineId } = {}) {
  const truckByName = new Map(vehicles.map((v) => [String(v.name ?? '').toUpperCase(), v]));
  const truckNamed = (name) => truckByName.get(String(name ?? '').toUpperCase()) ?? null;
  // The trucks the note named, by the Function or by the reader.
  const noted = [...new Set([...trucks, ...(reading.noteTrucks ?? [])].map(truckNamed).filter(Boolean))];
  // 3.1 Shared by the shop: the note says so ("shop inventory", "para el taller") and names no truck.
  const forShop = !noted.length && (reading.forShop === true || shopNote(note));
  // A receipt can't be from after its upload: a later date is a misread.
  const misdated = Boolean(reading.date && uploadedDate && reading.date > uploadedDate);
  const time = !misdated && /^([01]\d|2[0-3]):[0-5]\d$/.test(reading.time ?? '') ? reading.time : null;
  const base = { vendor: reading.vendor ?? '', date: (misdated ? null : reading.date) ?? uploadedDate ?? null, time, invoiceNumber: reading.invoiceNumber ?? null };
  if (!reading.readable) {
    return { ...base, status: 'unreadable', lines: [], fees: [], feesTotal: 0, tax: null, total: null, problems: [reading.problem || 'The photo could not be read'] };
  }
  const lines = reading.lines.map((l) => {
    const truck = truckNamed(l.truck) ?? (noted.length === 1 ? noted[0] : null);
    const price = l.lineTotal ?? (l.unitPrice != null ? round2(l.unitPrice * l.quantity) : null);
    const flags = price == null ? ['noPrice'] : [];
    // Fluids bought in bulk (oil, coolant, DEF, grease) are shop supplies, split across the fleet.
    const read = l.kind === 'credit' || (price != null && price < 0) ? 'credit' : l.kind === 'part' && bulkFluid(l.printed) ? 'supplies' : l.kind;
    // 3.1 A shop purchase: every item is a shop cost (tools stay tools, spread if big).
    const kind = forShop && read !== 'credit' && read !== 'tool' ? 'supplies' : read;
    const pool = POOL_KINDS.includes(kind);
    return {
      id: newId(),
      part: null,
      suggestedPart: null,
      kind,
      text: l.printed,
      partNumber: l.partNumber ?? null,
      qty: l.quantity,
      price,
      to: SHOP_KINDS.includes(kind) ? 'shop' : truck && (pool || kind === 'credit') ? 'truck' : null,
      vehicleId: truck && (pool || kind === 'credit') ? truck.id : null,
      for: null,
      truckFrom: truck && !SHOP_KINDS.includes(kind) ? (truckNamed(l.truck) ? l.truckSource ?? null : 'note') : null,
      truckChoices: !truck && noted.length > 1 && pool ? noted.map((v) => v.id) : null,
      flags,
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
  // A payment screenshot isn't a store receipt: it counts once admin approves it.
  const paidWith = reading.paidWith && reading.paidWith !== 'receipt' ? reading.paidWith : null;
  const approval = paidWith ? { paidWith, noReceipt: true, approval: 'pending' } : {};
  return { ...base, status, lines, fees, feesTotal, tax, total: reading.total ?? (lines.length ? sum : null), problems, ...approval };
}
