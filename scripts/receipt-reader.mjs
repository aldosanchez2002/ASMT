// Reading a receipt photo: what Claude is asked, the shape it must answer in,
// and how its answer becomes a receipt. Claude only reads and matches; this
// file decides what counts (sure matches go on the shelf, everything else is
// flagged for a person) and checks the math. No network here, so it's tested.

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

// The answer's shape (structured outputs: Claude can't return anything else).
export const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readable', 'problem', 'vendor', 'date', 'invoiceNumber', 'lines', 'tax', 'total'],
  properties: {
    readable: { type: 'boolean', description: 'false if the photo is too blurry, dark or cut off to read the items and total' },
    problem: { ...nullable('string'), description: 'what is wrong with the photo, if anything' },
    vendor: { ...nullable('string'), description: 'store name as printed' },
    date: { ...nullable('string'), description: 'purchase date, YYYY-MM-DD' },
    invoiceNumber: nullable('string'),
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['printed', 'partNumber', 'quantity', 'unitPrice', 'lineTotal', 'matchPartId', 'matchSure', 'matchReason', 'stockQuantity', 'truck'],
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
          truck: { ...nullable('string'), description: 'truck number from the list, only if the receipt prints its unit number or VIN for this line' },
        },
      },
    },
    tax: nullable('number'),
    total: nullable('number'),
  },
};

export const SYSTEM_PROMPT = `You read parts-store receipts for a trucking company's shop and match each item to the shop's stock list.

Read only what is printed. Never guess a price, quantity or part number; use null when something isn't there or can't be read. If the photo can't be read well enough to get the items and the total, set readable to false and say why in problem.

For each item, find the stock list part it is, using the part number first (including the cross-reference numbers listed with each part), then the description. Set matchSure to true only when the part number or an unmistakable description identifies it; when it's only a likely guess, give the id but set matchSure to false. Items that aren't on the stock list (wipers, rags, tools, labor, core charges, fees) get matchPartId null. For a matched part counted in gallons, give stockQuantity in gallons (a 55 gal drum bought once is 55). If the receipt prints a unit number or VIN for an item, give that truck's number from the truck list.`;

// The text that goes with the photo: the stock list and the trucks.
export function contextText(parts, vehicles) {
  const stock = parts.filter((p) => !p.archived).map((p) => {
    const packs = (p.packs ?? []).map((x) => `${x.name} = ${x.size} ${p.unit === 'gal' ? 'gal' : 'pcs'}`).join(', ');
    return `- id ${p.id}: ${p.name}${p.number ? ` | numbers: ${p.number}` : ''} | counted in ${p.unit === 'gal' ? 'gallons' : 'pieces'}${packs ? ` | sold as ${packs}` : ''}`;
  });
  const trucks = vehicles.filter((v) => v.name).map((v) => `- ${v.name}${v.vin ? ` VIN ${v.vin}` : ''}`);
  return `Stock list:\n${stock.join('\n')}\n\nTrucks:\n${trucks.join('\n')}\n\nRead the receipt in the photo.`;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Claude's reading -> the fields saved on the receipt.
 * Sure matches go on the shelf (`part` set). Unsure matches, items not on the
 * stock list (unless the receipt names a truck) and missing prices are flagged
 * and wait for a person; so does a total that doesn't add up.
 * @returns { status: 'read'|'review'|'unreadable', vendor, date, invoiceNumber, lines, tax, total, problems }
 */
export function receiptFromReading(reading, parts, vehicles, { uploadedDate } = {}) {
  const partById = new Map(parts.map((p) => [p.id, p]));
  const truckByName = new Map(vehicles.map((v) => [String(v.name ?? '').toUpperCase(), v]));
  // A receipt can't be from after its upload: a later date is a misread.
  const misdated = Boolean(reading.date && uploadedDate && reading.date > uploadedDate);
  const base = { vendor: reading.vendor ?? '', date: (misdated ? null : reading.date) ?? uploadedDate ?? null, invoiceNumber: reading.invoiceNumber ?? null };
  if (!reading.readable) {
    return { ...base, status: 'unreadable', lines: [], tax: null, total: null, problems: [reading.problem || 'The photo could not be read'] };
  }
  const lines = reading.lines.map((l) => {
    const part = l.matchPartId ? partById.get(l.matchPartId) : null;
    const sure = Boolean(part && l.matchSure);
    const truck = l.truck ? truckByName.get(l.truck.toUpperCase()) : null;
    const price = l.lineTotal ?? (l.unitPrice != null ? round2(l.unitPrice * l.quantity) : null);
    // Gallons for oil (a drum is its size), pieces for everything else.
    const qty = sure && part.unit === 'gal' ? l.stockQuantity : l.quantity;
    const flags = [];
    if (part && !sure) flags.push('unsure');
    if (!part && !truck) flags.push('notOnList');
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
