// Parts: what the shop keeps on hand, what each service uses (the kits), and
// what the buyer needs to get. Plain ES module, no dependencies, so the tests
// and the website share it.
//
// Stock is never stored as a running number. It's worked out from the last
// count, plus what receipts brought in, minus what the work log used, so
// undoing a work entry or a receipt puts the stock back by itself.

import { SERVICE_ITEMS, JOBS } from './services.js';

// Service tags whose parts depend on the engine; the rest (air filter, air
// dryer, grease) depend on the truck model, so they hang off its chassis
// schedule.
export const ENGINE_TAGS = ['oil', 'fuelFilters'];
export const KIT_TAGS = ['oil', 'fuelFilters', 'airFilter', 'airDryer'];
export const kitCategory = (tag) => (ENGINE_TAGS.includes(tag) ? 'engine' : 'chassis');

// Parts the work log uses without a kit: tires by position, batteries.
export const AUTO_USES = ['steerTire', 'driveTire', 'trailerTire', 'battery'];

// The kit a tag uses on this truck: its engine or chassis schedule.
export function kitKey(vehicle, tag, schedules) {
  const category = kitCategory(tag);
  return (vehicle.scheduleIds ?? []).find((x) => schedules.get(x)?.category === category) ?? null;
}

// Tags covered by schedule item keys ("{scheduleId}__{itemId}").
export function tagsForKeys(keys = []) {
  const items = new Set(keys.map((k) => k.split('__')[1]));
  return Object.keys(SERVICE_ITEMS).filter((tag) => SERVICE_ITEMS[tag].some((id) => items.has(id)));
}

// Tags for the jobs ticked in Record work (a PM is oil + fuel filters + grease).
export const tagsForJobs = (jobIds = []) => [...new Set(JOBS.filter((j) => jobIds.includes(j.id)).flatMap((j) => j.tags))];

const add = (into, partId, qty) => {
  if (!partId || !(qty > 0)) return into;
  into[partId] = round((into[partId] ?? 0) + qty);
  return into;
};
const round = (n) => Math.round(n * 100) / 100;

/**
 * Parts a set of service tags uses on one truck, from the kits.
 * @param kits  meta/kits doc: { [kitKey]: { [tag]: [{ part, qty }] } }
 * @returns { parts: { partId: qty }, missing: [tag] } — missing are tags
 *   with no kit set up for this truck
 */
export function kitParts(vehicle, tags, kits = {}, schedules = new Map()) {
  const parts = {};
  const missing = [];
  for (const tag of tags) {
    if (!KIT_TAGS.includes(tag)) continue;
    const kit = kits[kitKey(vehicle, tag, schedules)]?.[tag];
    if (!kit?.length) { missing.push(tag); continue; }
    for (const line of kit) add(parts, line.part, Number(line.qty));
  }
  return { parts, missing };
}

// The part set to be used automatically for steer / drive / trailer tires or
// batteries (the first one marked, if several are).
export const autoPart = (parts, use) => parts.find((p) => p.autoUse === use && !p.archived) ?? null;

// Tires replaced (positions) -> parts. Truck steer positions start with "S";
// trailer positions are all "trailerTire".
export function tireParts(positions = [], parts = [], { trailer = false } = {}) {
  const out = {};
  for (const pos of positions) {
    const use = trailer ? 'trailerTire' : pos.startsWith('S') ? 'steerTire' : 'driveTire';
    add(out, autoPart(parts, use)?.id, 1);
  }
  return out;
}

export const batteryParts = (count, parts = []) => add({}, autoPart(parts, 'battery')?.id, count ?? 0);

const toMs = (x) => {
  if (x == null) return 0;
  if (typeof x === 'number') return x;
  if (typeof x.toMillis === 'function') return x.toMillis();
  return Date.parse(x) || 0;
};

/**
 * What's on the shelf now. Starts from the last count (or 0 when the part
 * was added, so old work from before stock tracking doesn't count), then adds
 * receipt lines put into stock and takes off what work entries used, both
 * only when they were recorded after that starting point.
 * @param part     { id, countQty, countAt, createdAt }
 * @param receipts [{ createdAt|createdMs, lines: [{ part, qty }] }]
 * @param log      serviceLog entries [{ loggedAt|loggedAtMs, partsUsed: { partId: qty } }]
 */
export function onHand(part, receipts = [], log = []) {
  const since = toMs(part.countAt ?? part.createdAt);
  let qty = Number(part.countQty ?? 0);
  for (const r of receipts) {
    if ((r.createdMs ?? toMs(r.createdAt)) <= since) continue;
    for (const line of r.lines ?? []) if (line.part === part.id) qty += Number(line.qty) || 0;
  }
  for (const e of log) {
    if ((e.loggedAtMs ?? toMs(e.loggedAt)) <= since) continue;
    qty -= Number(e.partsUsed?.[part.id]) || 0;
  }
  return round(qty);
}

/**
 * The parts upcoming work will use: services due soon or overdue on each
 * truck (from its kits) and tires past their limit.
 * @param trucks  [{ id, name, scheduleIds, rows: [{ key, status }], wornTires: [pos] }]
 * @param trailers [{ id, name, worn: [pos] }]
 * @returns [{ unitId, unitName, what: 'service'|'tires', tags, status, parts, missing }]
 */
export function upcomingWork(trucks, trailers, kits, schedules, parts) {
  const out = [];
  for (const v of trucks) {
    const due = (v.rows ?? []).filter((r) => r.status === 'overdue' || r.status === 'soon');
    const tags = tagsForKeys(due.map((r) => r.key)).filter((tag) => KIT_TAGS.includes(tag));
    if (tags.length) {
      const { parts: used, missing } = kitParts(v, tags, kits, schedules);
      const status = due.some((r) => r.status === 'overdue') ? 'overdue' : 'soon';
      out.push({ unitId: v.id, unitName: v.name, what: 'service', tags, status, parts: used, missing });
    }
    if (v.wornTires?.length) {
      out.push({ unitId: v.id, unitName: v.name, what: 'tires', tires: v.wornTires, status: 'overdue', parts: tireParts(v.wornTires, parts), missing: [] });
    }
  }
  for (const c of trailers) {
    if (!c.worn?.length) continue;
    out.push({ unitId: c.id, unitName: c.name, what: 'tires', tires: c.worn, trailer: true, status: 'overdue', parts: tireParts(c.worn, parts, { trailer: true }), missing: [] });
  }
  return out;
}

/**
 * The shopping list: for each part, what upcoming work needs plus the
 * part's minimum on hand, minus what's on the shelf.
 * @returns [{ part, need, min, have, buy, packs: [{ name, size, count }] }]
 *   only parts with something to buy, biggest shortfall first
 */
export function shoppingList(parts, work, stock) {
  const need = {};
  for (const w of work) for (const [id, qty] of Object.entries(w.parts)) add(need, id, qty);
  const list = [];
  for (const part of parts) {
    if (part.archived) continue;
    const n = need[part.id] ?? 0;
    const min = Number(part.min) || 0;
    const have = stock[part.id] ?? 0;
    const buy = round(Math.max(0, n + min - Math.max(have, 0)));
    if (buy <= 0) continue;
    list.push({ part, need: n, min, have, buy, packs: packsFor(part, buy) });
  }
  return list.sort((a, b) => (a.part.group ?? '').localeCompare(b.part.group ?? '') || b.buy - a.buy);
}

// How many of each pack (drum, case…) covers a quantity.
export const packsFor = (part, qty) => (part.packs ?? [])
  .filter((p) => Number(p.size) > 0)
  .map((p) => ({ name: p.name, size: Number(p.size), count: Math.ceil(qty / Number(p.size) - 1e-9) }));

// Average price paid per unit, from receipt lines with a price.
export function averageCost(partId, receipts = []) {
  let qty = 0;
  let spent = 0;
  for (const r of receipts) {
    for (const line of r.lines ?? []) {
      if (line.part !== partId || !(Number(line.qty) > 0) || line.price == null || line.price === '') continue;
      qty += Number(line.qty);
      spent += Number(line.price);
    }
  }
  return qty ? spent / qty : null;
}
