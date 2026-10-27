// Reading a receipt photo: what Claude is asked, the shape it must answer in,
// and how its answer becomes a receipt. Claude only reads and matches; this
// file decides what counts (sure matches go on the shelf, everything else is
// flagged for a person) and checks the math. No network here, so it's tested.

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

// The answer's shape (structured outputs: Claude can't return anything else).
export const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readable', 'problem', 'vendor', 'date', 'invoiceNumber', 'noteTrucks', 'lines', 'tax', 'total'],
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
        required: ['printed', 'partNumber', 'quantity', 'unitPrice', 'lineTotal', 'matchPartId', 'matchSure', 'matchReason', 'stockQuantity', 'truck', 'truckSource'],
        properties: {
          printed: { type: 'string', description: 'the item text as printed' },
          partNumber: nullable('string'),
          quantity: { type: 'number', description: 'quantity as printed' },
          unitPrice: nullable('number'),
          lineTotal: { ...nullable('number'), description: 'the line amount as printed, before tax' },
          matchPartId: { ...nullable('string'), description: 'id from the stock list, or null if none fits' },
          matchSure: { type: 'boolean', description: 'true only if the part number or an exact name/cross-reference identifies it' },
          matchReason: { type: 'string' },
          stockQuantity: { ...nullable('number'), description: "quantity in the matched part's counting unit (gallons for oil: 1 drum = its gallons)" },
          truck: { ...nullable('string'), description: 'truck number from the truck list this item is for, or null if nothing says' },
          truckSource: { anyOf: [{ type: 'string', enum: ['printed', 'handwritten', 'note'] }, { type: 'null' }], description: 'what tied the item to the truck' },
        },
      },
    },
    tax: nullable('number'),
    total: nullable('number'),
  },
};

export const SYSTEM_PROMPT = `You read parts-store receipts for a trucking company's shop and match each item to the shop's stock list.

Read only what is printed. Never guess a price, quantity or part number; use null when something isn't there or can't be read. If the photo can't be read well enough to get the items and the total, set readable to false and say why in problem.

For each item, find the stock list part it is, using the part number first (including the cross-reference numbers listed with each part), then the description. Set matchSure to true only when the part number or an unmistakable description identifies it; when it's only a likely guess, give the id but set matchSure to false. Items that aren't on the stock list (wipers, rags, tools, labor, core charges, fees) get matchPartId null. For a matched part counted in gallons, give stockQuantity in gallons (a 55 gal drum bought once is 55).

Which truck each item is for: one receipt often has parts for several trucks. Set truck (a name from the truck list) only when something says so, and set truckSource to what said it:
- printed: the receipt prints a unit number, truck ID or VIN for the item (or for the whole receipt).
- handwritten: a truck number is written by hand next to the item (or across the whole receipt).
- note: the buyer's note ties it to a truck. A note naming one truck and nothing else means every item is for that truck. A note like "28 drums, 31 headlight" ties items by what they are. Bare numbers in a note are truck numbers (28 = T-28).
List every truck the note mentions in noteTrucks. If the note names several trucks and nothing tells you which one an item is for, leave its truck null rather than guess.`;

// The text that goes with the photo: the stock list, the trucks, and the
// note the buyer sent with it (if any).
export function contextText(parts, vehicles, note = null) {
  const stock = parts.filter((p) => !p.archived).map((p) => {
    const packs = (p.packs ?? []).map((x) => `${x.name} = ${x.size} ${p.unit === 'gal' ? 'gal' : 'pcs'}`).join(', ');
    return `- id ${p.id}: ${p.name}${p.number ? ` | numbers: ${p.number}` : ''} | counted in ${p.unit === 'gal' ? 'gallons' : 'pieces'}${packs ? ` | sold as ${packs}` : ''}`;
  });
  const trucks = vehicles.filter((v) => v.name).map((v) => `- ${v.name}${v.vin ? ` VIN ${v.vin}` : ''}`);
  const noteText = note ? `\n\nThe buyer's note sent with the photo: "${note.replace(/\s+/g, ' ')}"` : '';
  return `Stock list:\n${stock.join('\n')}\n\nTrucks:\n${trucks.join('\n')}${noteText}\n\nRead the receipt in the photo.`;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Claude's reading -> the fields saved on the receipt.
 * Sure matches go on the shelf (`part` set), noting the truck they were bought
 * for. Items not on the stock list go to their truck. Unsure matches, items
 * with no truck, and missing prices are flagged and wait for a person; so
 * does a total that doesn't add up. `trucks` are the trucks the WhatsApp note
 * named: when it named only one, every item is for it; when it named several,
 * an item with no truck is flagged "which truck" with just those as choices.
 * @returns { status: 'read'|'review'|'unreadable', vendor, date, invoiceNumber, lines, tax, total, problems }
 */
export function receiptFromReading(reading, parts, vehicles, { uploadedDate, trucks = [] } = {}) {
  const partById = new Map(parts.map((p) => [p.id, p]));
  const truckByName = new Map(vehicles.map((v) => [String(v.name ?? '').toUpperCase(), v]));
  const truckNamed = (name) => truckByName.get(String(name ?? '').toUpperCase()) ?? null;
  // The trucks the note named, by the Function or by the reader.
  const noted = [...new Set([...trucks, ...(reading.noteTrucks ?? [])].map(truckNamed).filter(Boolean))];
  // A receipt can't be from after its upload: a later date is a misread.
  const misdated = Boolean(reading.date && uploadedDate && reading.date > uploadedDate);
  const base = { vendor: reading.vendor ?? '', date: (misdated ? null : reading.date) ?? uploadedDate ?? null, invoiceNumber: reading.invoiceNumber ?? null };
  if (!reading.readable) {
    return { ...base, status: 'unreadable', lines: [], tax: null, total: null, problems: [reading.problem || 'The photo could not be read'] };
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
    if (!part && !truck) flags.push(noted.length > 1 ? 'whichTruck' : 'notOnList');
    if (sure && part.unit === 'gal' && !(l.stockQuantity > 0)) flags.push('quantity');
    if (price == null) flags.push('noPrice');
    const counts = sure && !flags.includes('quantity');
    return {
      part: counts ? part.id : null,
      suggestedPart: part && !counts ? part.id : null,
      text: l.printed,
      partNumber: l.partNumber ?? null,
      qty: qty ?? l.quantity,
      price,
      to: counts ? 'stock' : truck ? 'truck' : null,
      vehicleId: truck && !counts ? truck.id : null,
      for: truck && counts ? [{ id: truck.id, name: truck.name }] : null,
      truckFrom: truck ? (truckNamed(l.truck) ? l.truckSource ?? null : 'note') : null,
      truckChoices: !truck && noted.length > 1 ? noted.map((v) => v.id) : null,
      flags,
      matchReason: l.matchReason,
    };
  });
  const problems = [];
  const sum = lines.reduce((s, l) => s + (l.price ?? 0), 0) + (reading.tax ?? 0);
  if (reading.total != null && lines.every((l) => l.price != null) && Math.abs(sum - reading.total) > 0.05) {
    problems.push(`Items plus tax come to $${sum.toFixed(2)}, but the receipt total is $${reading.total.toFixed(2)}`);
  }
  if (!lines.length) problems.push('No items were found on the receipt');
  if (misdated) problems.push(`The date was read as ${reading.date}, after the upload; check it`);
  const status = problems.length || lines.some((l) => l.flags.length) ? 'review' : 'read';
  return { ...base, status, lines, tax: reading.tax ?? null, total: reading.total ?? (lines.length ? round2(sum) : null), problems };
}
