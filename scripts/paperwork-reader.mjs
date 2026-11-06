// Reading a registration or inspection paper the office texts in ("54231
// registration", "T-24 inspection" with the photo), the same way a receipt
// is read: Claude reads the paper, this file decides which unit it's for,
// the new dates, and the fee. The fee counts toward that unit's cost (a
// "paperwork" line, web/items.js) and the dates update compliance/{unitId}
// with a history entry. No network here, so it's tested.

import { nextInspection } from '../web/compliance.js';

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

export const PAPERWORK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readable', 'problem', 'kind', 'unitNumber', 'vin', 'plate', 'state', 'issuedOn', 'inspectedOn', 'expires', 'fee', 'agency'],
  properties: {
    readable: { type: 'boolean', description: 'false if the paper is too blurry, dark or cut off to read its dates' },
    problem: { ...nullable('string'), description: 'what is wrong with the photo, if anything' },
    kind: { type: 'string', enum: ['registration', 'inspection', 'other'], description: 'a registration, cab card or registration receipt; an annual (DOT) inspection report or sticker; or something else' },
    unitNumber: { ...nullable('string'), description: 'the unit, trailer or fleet number printed or handwritten on the paper (like "TR 54264" or "Trailer/Chassis Number 4002"), if any' },
    vin: { ...nullable('string'), description: 'the VIN as printed (17 characters)' },
    plate: { ...nullable('string'), description: 'the license plate as printed' },
    state: { ...nullable('string'), description: 'the two-letter state of the registration or plate' },
    issuedOn: { ...nullable('string'), description: 'when the registration was issued or paid, YYYY-MM-DD' },
    inspectedOn: { ...nullable('string'), description: 'the inspection date, YYYY-MM-DD' },
    expires: { ...nullable('string'), description: 'when the registration expires, or when the next inspection is due if printed, YYYY-MM-DD' },
    fee: { ...nullable('number'), description: 'the total amount paid, if printed' },
    agency: { ...nullable('string'), description: 'who issued it: the state office, tag agency or inspection shop' },
  },
};

export const PAPERWORK_PROMPT = `You read registration and inspection papers for a trucking company's trucks and trailers.

Read only what is printed. Never guess a date, plate, VIN or amount; use null when something isn't there or can't be read. If the photo can't be read well enough to get the dates, set readable to false and say why in problem.

kind: "registration" for a registration, cab card (IRP), or a registration renewal receipt; "inspection" for an annual or DOT inspection report or sticker; "other" for anything else.

expires: for a registration, the expiration date; for an inspection, the next due date only if one is printed (otherwise null). Dates are YYYY-MM-DD; a month and year only ("12/2027") means the last day of that month. fee: the total paid, including any fees, if printed.`;

// The note and the unit lists that go with the photo.
export function paperworkContext(units, note = null) {
  const list = units.map((u) => `- ${u.name} (${u.unitType})${u.vin ? ` VIN ${u.vin}` : ''}${u.plate ? ` plate ${u.plate}` : ''}`);
  return `Trucks and trailers:\n${list.join('\n')}${note ? `\n\nThe note sent with the photo: "${note.replace(/\s+/g, ' ')}"` : ''}\n\nRead the paper in the photo.`;
}

const clean = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Which unit the note names: "T-24", "truck 24", "54231", "LC106", "24".
 * A bare number is a trailer with that name, else truck T-NN. Only units in
 * the list count; null unless exactly one matches.
 */
export function unitFromNote(note, units) {
  if (!note) return null;
  const found = new Set();
  for (const m of note.matchAll(/(?:^|[^\p{L}\d])(?:t|truck|cami[oó]n|unidad)\s*-?\s*(\d{1,3})(?!\d)/giu)) {
    const u = units.find((x) => x.unitType === 'truck' && x.name === `T-${pad2(m[1])}`);
    if (u) found.add(u);
  }
  for (const token of note.split(/[^\p{L}\d-]+/u).map(clean).filter(Boolean)) {
    const trailer = units.find((x) => x.unitType === 'trailer' && clean(x.name) === token);
    const truck = /^\d{1,3}$/.test(token) ? units.find((x) => x.unitType === 'truck' && x.name === `T-${pad2(Number(token))}`) : null;
    if (trailer ?? truck) found.add(trailer ?? truck);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Claude's reading -> what's saved on the receipt, plus the compliance
 * change. The unit is the one the note names; if the note names none, the
 * unit number written on the paper, then its VIN or plate. A paper for a different VIN than the unit's is
 * flagged. With no fee there's no cost line.
 * @param units [{ id, name, unitType: 'truck'|'trailer', vin, plate }]
 * @returns { receipt: { status, vendor, date, total, lines, problems, paperwork }, change: null | { unitId, fields, entry } }
 */
export function paperworkFromReading(reading, units, { note = null, docType = null, today, newId = () => Math.random().toString(36).slice(2, 10) } = {}) {
  const kind = reading.kind === 'other' ? docType : reading.kind ?? docType;
  const problems = [];
  if (!reading.readable) problems.push(reading.problem || 'The paper could not be read');
  const byNote = unitFromNote(note, units);
  // A unit number on the paper itself ("TR 54264" written at the top).
  const byPaper = unitFromNote(reading.unitNumber, units);
  const byVin = reading.vin ? units.find((u) => u.vin && clean(u.vin) === clean(reading.vin)) : null;
  const byPlate = reading.plate ? units.find((u) => u.plate && clean(u.plate) === clean(reading.plate)) : null;
  const unit = byNote ?? byPaper ?? byVin ?? byPlate ?? null;
  if (!unit) problems.push('Which truck or trailer this paper is for is not clear');
  if (unit && byVin && byVin.id !== unit.id) problems.push(`The VIN on the paper is ${byVin.name}'s, not ${unit.name}'s`);
  if (kind !== 'registration' && kind !== 'inspection') problems.push('This is not a registration or an inspection');
  const dateOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
  const expires = kind === 'inspection'
    ? (dateOk(reading.expires) ? reading.expires : dateOk(reading.inspectedOn) ? nextInspection(reading.inspectedOn) : null)
    : (dateOk(reading.expires) ? reading.expires : null);
  if (reading.readable && !expires) problems.push(kind === 'inspection' ? 'No inspection date could be read' : 'No expiration date could be read');
  const date = (kind === 'inspection' ? reading.inspectedOn : reading.issuedOn) ?? today ?? null;
  const fee = Number(reading.fee) > 0 ? Math.round(reading.fee * 100) / 100 : null;
  const label = kind === 'inspection' ? 'Inspection' : 'Registration';
  const lines = fee != null ? [{
    id: newId(), kind: 'paperwork', text: `${label}${unit ? ` · ${unit.name}` : ''}${expires ? ` (to ${expires})` : ''}`, qty: 1, price: fee, cost: fee,
    to: unit ? 'truck' : null, vehicleId: unit?.id ?? null, assetType: unit?.unitType ?? null, flags: [],
  }] : [];
  const paperwork = { kind, unitId: unit?.id ?? null, unitName: unit?.name ?? null, unitType: unit?.unitType ?? null, expires, plate: reading.plate ?? null, state: reading.state ?? null, fee };
  const receipt = { status: problems.length ? 'review' : 'read', vendor: reading.agency ?? '', date, total: fee, tax: null, fees: [], feesTotal: 0, lines, problems, paperwork };
  if (!unit || !expires || problems.length) return { receipt, change: null };
  const fields = kind === 'inspection' ? { inspectionExpires: expires }
    : { registrationExpires: expires, ...(reading.plate ? { plate: reading.plate } : {}), ...(reading.state ? { registrationState: reading.state, plateState: reading.state } : {}) };
  return { receipt, change: { unitId: unit.id, unitName: unit.name, unitType: unit.unitType, fields, entry: { kind, expires, fee, date, plate: reading.plate ?? null } } };
}

// The text back to the sender once the paper is read.
export function paperworkReplyText({ paperwork, problems }) {
  const label = paperwork.kind === 'inspection' ? 'inspection' : 'registration';
  if (!paperwork.unitId) return `Read a ${label}, but which truck or trailer it's for isn't clear. The office will set it.`;
  const when = paperwork.expires ? `good to ${new Date(`${paperwork.expires}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'no date read';
  const extra = [paperwork.kind === 'registration' && paperwork.plate ? `plate ${paperwork.plate}${paperwork.state ? ` (${paperwork.state})` : ''}` : null, paperwork.fee != null ? `$${paperwork.fee.toFixed(2)}` : null].filter(Boolean);
  const head = `Read ${label} for ${paperwork.unitName}: ${when}${extra.length ? `, ${extra.join(', ')}` : ''}.`;
  return problems?.length ? `${head} The office will check it.` : `${head} Updated in aslog. Wrong unit? Reply with the unit number.`;
}
