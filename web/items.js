// Items: every line of every receipt, and where each one went.
//
// Everything bought is stock until it's used. Each receipt line is a batch
// ("lot") with its real price (landedCosts) and its photo, and every cost on
// a truck is a use of a batch, so it points back to the receipt that paid
// for it. The receipt reader gives each line a kind:
//   stock     a part in the parts list (filters, oil, tires, batteries): the
//             work log says how many it used (kits, tires, batteries), and
//             those come out of the oldest batch first, by rule (ruleUses)
//   part      a repair part bought for a job
//   labor     outside labor (a dealer or another shop)
//   core      a core charge (it goes with the part it came with)
//   fee       a charge that comes with an item (state battery or tire fee,
//             disposal): it goes with that item too
//   supplies  shop supplies: cleaners, rags, grease
//   tool      shop tools
//   credit    a return or credit (negative)
// Repair parts, labor and cores wait in the "pool" until they're tied to the
// work they were used in: the matcher (scripts/match-items.mjs) suggests a
// repair for each one, and admin confirms or changes it. Supplies and tools
// are shop costs the day they're bought. Each use of a batch is an itemUses
// doc:
//   { receiptId, lineId, part, qty, logId, vehicleId, vehicleName, assetType,
//     shop, by: 'rule'|'ai'|'admin', status, confidence, reason, createdAt }
// status: 'auto' (by rule, or the AI was sure: counted), 'doubt' (unsure,
// waits for admin), 'confirmed' (admin said so), 'rejected' (admin said no;
// kept so the AI doesn't suggest it again), 'snooze' (admin: still on the
// shelf). Uses are only added or changed in status, never re-priced: a use
// costs its batch's price, so last month's costs don't move.
// Plain ES module with no dependencies, shared by the website, the scripts
// and the tests.

export const POOL_KINDS = ['part', 'labor', 'core'];
export const SHOP_KINDS = ['supplies', 'tool'];
export const KINDS = ['stock', ...POOL_KINDS, 'fee', ...SHOP_KINDS, 'credit'];
// Uses that hold an item (it isn't free to match again).
export const HOLDING = ['auto', 'doubt', 'confirmed'];
// Uses that count in what a truck cost.
export const COUNTED = ['auto', 'confirmed'];
// The AI ties an item to a repair on its own when at least this sure.
export const AUTO_CONFIDENCE = 85;
// A batch on a receipt dated up to this many days after the work can still
// cover it (the receipt is sometimes dated the day after).
export const LATE_DAYS = 2;
// Batches still on the shelf after this many days show in Review.
export const OLD_STOCK_DAYS = 60;
// Tools over this much are spread over 12 months in the costs.
export const SPREAD_TOOLS_OVER = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;
const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);
const toMs = (x) => (x == null ? 0 : typeof x === 'number' ? x : typeof x.toMillis === 'function' ? x.toMillis() : Date.parse(x) || 0);

/**
 * What each line really cost: its price plus its share of the tax and fees
 * (card fee, surcharge, shipping), split by price. Returns and lines with no
 * price get no share. The shares are rounded so they add up to the cent.
 * @returns [cost|null] in line order
 */
export function landedCosts(lines, extra = 0) {
  const prices = lines.map((l) => (l.price == null || l.price === '' ? null : Number(l.price)));
  const base = prices.reduce((s, p) => s + (p > 0 ? p : 0), 0);
  const costs = prices.map((p) => (p == null ? null : p > 0 && base ? round2(p + (extra * p) / base) : round2(p)));
  // Rounding leftovers go on the biggest line.
  const shared = prices.reduce((s, p, i) => s + (p > 0 ? costs[i] - p : 0), 0);
  const left = round2(base ? extra - shared : 0);
  if (left && base) {
    const big = prices.indexOf(Math.max(...prices.filter((p) => p > 0)));
    costs[big] = round2(costs[big] + left);
  }
  return costs;
}

// The kind of a line, including lines saved before kinds existed.
export function lineKind(line) {
  if (line.part) return 'stock';
  if (KINDS.includes(line.kind)) return line.kind;
  if (line.to === 'shop') return 'supplies';
  return 'part';
}

// A line's id: saved on it, or (older receipts) its position.
export const lineIdOf = (line, i) => line.id ?? `i${i}`;
export const itemKey = (receiptId, lineId) => `${receiptId}:${lineId}`;

// A fee that comes with an item: kind 'fee', or (older readings) shop
// supplies that are plainly a battery, tire or disposal fee.
const isItemFee = (l) => lineKind(l) === 'fee'
  || (lineKind(l) === 'supplies' && /fee/i.test(l.text ?? '') && /batter|tire|tyre|disposal|environmental|recycl|hazmat/i.test(l.text ?? ''));

/**
 * Add-ons go with the part they came with: each core charge (and the core
 * return on the same receipt that cancels it, if any) and each item fee
 * (state battery or tire fee, disposal) is folded into that part's line, the
 * one whose description shares the most words with it (else the biggest
 * part on the receipt). The add-on's cost (for a returned core, what's left:
 * its share of tax and fees) becomes part of that part's cost, so nobody has
 * to match it to work and it lands on the same truck.
 * @returns { extra: Map(lineId -> amount added), absorbed: Set(lineId) }
 */
export function addOnLinks(r) {
  const lines = r.lines ?? [];
  const extra = new Map();
  const absorbed = new Set();
  const costOf = (l) => Number(l.cost ?? l.price) || 0;
  const words = (l) => new Set(String(l.text ?? '').toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z0-9]+/).map((w) => w.replace(/(ies|s)$/, (m) => (m === 'ies' ? 'y' : '')))
    .filter((w) => w.length > 1 && !['core', 'return', 'deposit', 'credit', 'fee', 'sale', 'state', 'texa'].includes(w)));
  const targets = lines.map((l, i) => i).filter((i) => ['stock', 'part'].includes(lineKind(lines[i])));
  const isCoreReturn = (l) => lineKind(l) === 'credit' && /core/i.test(l.text ?? '');
  lines.forEach((core, i) => {
    const fee = isItemFee(core);
    if ((lineKind(core) !== 'core' && !fee) || !targets.length) return;
    const mine = words(core);
    const shared = (j) => [...words(lines[j])].filter((w) => mine.has(w)).length;
    const target = targets.reduce((best, j) => (shared(j) > shared(best) || (shared(j) === shared(best) && costOf(lines[j]) > costOf(lines[best])) ? j : best), targets[0]);
    absorbed.add(lineIdOf(core, i));
    let amount = costOf(core);
    const back = fee ? -1 : lines.findIndex((l, j) => !absorbed.has(lineIdOf(l, j)) && (isCoreReturn(l) || (lineKind(l) === 'credit' && Math.abs(Number(l.price)) === Math.abs(Number(core.price)))));
    if (back >= 0) {
      absorbed.add(lineIdOf(lines[back], back));
      amount += costOf(lines[back]);
    }
    const id = lineIdOf(lines[target], target);
    extra.set(id, round2((extra.get(id) ?? 0) + amount));
  });
  return { extra, absorbed };
}

/**
 * Every non-stock line of the receipts that have been read, as items.
 * @returns [{ key, receiptId, lineId, text, partNumber, kind, qty, cost,
 *   unitCost, date, vendor, vehicleId, truckChoices, note }]
 */
export function receiptItems(receipts) {
  const out = [];
  for (const r of receipts) {
    if (r.status === 'waiting' || r.status === 'unreadable' || r.status === 'error') continue;
    const cores = addOnLinks(r);
    (r.lines ?? []).forEach((l, i) => {
      // A fee with no part to go with is a shop cost.
      const kind = lineKind(l) === 'fee' ? 'supplies' : lineKind(l);
      const lineId = lineIdOf(l, i);
      if (kind === 'stock' || cores.absorbed.has(lineId)) return;
      const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
      const base = l.cost ?? (l.price == null || l.price === '' ? null : Number(l.price));
      const cost = base == null ? null : round2(base + (cores.extra.get(lineId) ?? 0));
      out.push({
        key: itemKey(r.id, lineId), receiptId: r.id, lineId, text: l.text ?? '', partNumber: l.partNumber ?? null,
        kind, qty, cost, unitCost: cost == null ? null : cost / qty, date: r.date ?? null, vendor: r.vendor ?? '',
        vehicleId: l.to === 'truck' ? l.vehicleId ?? null : null, truckChoices: l.truckChoices ?? null, note: r.note ?? null,
      });
    });
  }
  return out;
}

const isRead = (r) => r.status !== 'waiting' && r.status !== 'unreadable' && r.status !== 'error';

/**
 * The stock batches: lines of read receipts matched to a part in the parts
 * list. `forIds` are the trucks the buyer's note set it aside for.
 * @returns [{ key, receiptId, lineId, part, qty, cost, unitCost, date, vendor, forIds }]
 */
export function stockLots(receipts) {
  const out = [];
  for (const r of receipts) {
    if (!isRead(r)) continue;
    const cores = addOnLinks(r);
    (r.lines ?? []).forEach((l, i) => {
      if (!l.part || !(Number(l.qty) > 0)) return;
      const qty = Number(l.qty);
      const lineId = lineIdOf(l, i);
      const base = l.cost ?? (l.price == null || l.price === '' ? null : Number(l.price));
      const cost = base == null ? null : round2(base + (cores.extra.get(lineId) ?? 0));
      out.push({
        key: itemKey(r.id, lineId), receiptId: r.id, lineId, part: l.part, qty, cost, unitCost: cost == null ? null : cost / qty,
        date: r.date ?? null, vendor: r.vendor ?? '', forIds: (l.for ?? []).map((u) => u.id).filter(Boolean),
      });
    });
  }
  return out;
}

const workOrder = (a, b) => (a.date ?? '').localeCompare(b.date ?? '') || toMs(a.loggedAt) - toMs(b.loggedAt) || String(a.id).localeCompare(String(b.id));
const lotOrder = (a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.key.localeCompare(b.key);

// What a work entry used of a part that no batch covers yet.
export function uncovered(entry, partId, uses) {
  const need = Number(entry.partsUsed?.[partId]) || 0;
  const covered = uses.filter((u) => u.logId === entry.id && u.part === partId && HOLDING.includes(u.status)).reduce((s, u) => s + (Number(u.qty) || 0), 0);
  return round2(Math.max(0, need - covered));
}

/**
 * The uses the rules add: what each work entry used of a part (its
 * partsUsed) comes out of the oldest batch of that part with some left, first
 * from batches set aside for that truck, then from ones set aside for nobody,
 * then from the rest. Only batches bought by the work's date (+ LATE_DAYS)
 * count, so old work from before a part was bought here stays "no receipt".
 * Work is covered oldest first; what's already covered stays as it is.
 * @returns new itemUses docs (no ids), by: 'rule'
 */
export function ruleUses({ receipts, uses, log }) {
  const lots = stockLots(receipts).sort(lotOrder);
  const left = new Map(lots.map((lot) => [lot.key, round2(lot.qty - holdingQty(lot.key, uses))]));
  const added = [];
  for (const e of log.filter((x) => x.partsUsed && x.date).sort(workOrder)) {
    for (const partId of Object.keys(e.partsUsed)) {
      let need = uncovered(e, partId, uses);
      if (!need) continue;
      const latest = addDays(e.date, LATE_DAYS);
      const rank = (lot) => (lot.forIds.includes(e.vehicleId) ? 0 : lot.forIds.length ? 2 : 1);
      const fits = lots.filter((lot) => lot.part === partId && lot.date && lot.date <= latest && left.get(lot.key) > 0)
        .sort((a, b) => rank(a) - rank(b) || lotOrder(a, b));
      for (const lot of fits) {
        if (!need) break;
        const qty = round2(Math.min(need, left.get(lot.key)));
        left.set(lot.key, round2(left.get(lot.key) - qty));
        need = round2(need - qty);
        added.push({
          receiptId: lot.receiptId, lineId: lot.lineId, part: partId, qty, logId: e.id, vehicleId: e.vehicleId ?? null,
          vehicleName: e.vehicleName ?? null, assetType: e.assetType === 'trailer' ? 'trailer' : 'truck', shop: false,
          by: 'rule', status: 'auto', confidence: 100, reason: 'Oldest batch of this part',
        });
      }
    }
  }
  return added;
}

// What each use of a batch costs: its share of the batch's cost, rounded so
// the uses of a whole batch add up to the cent (the last one takes the
// leftover cent). Uses in the order they happened.
function useAmounts(cost, qty, list, dateOf) {
  const out = new Map();
  if (cost == null || !(qty > 0)) return out;
  let before = 0;
  const sorted = [...list].sort((a, b) => (dateOf(a) ?? '').localeCompare(dateOf(b) ?? '') || toMs(a.createdAt) - toMs(b.createdAt) || String(a.id ?? '').localeCompare(String(b.id ?? '')));
  for (const u of sorted) {
    const q = Number(u.qty) || 0;
    out.set(u, round2(round2((cost * (before + q)) / qty) - round2((cost * before) / qty)));
    before += q;
  }
  return out;
}

export const usesFor = (key, uses) => uses.filter((u) => itemKey(u.receiptId, u.lineId) === key);
const holdingQty = (key, uses) => usesFor(key, uses).filter((u) => HOLDING.includes(u.status)).reduce((s, u) => s + (Number(u.qty) || 0), 0);
export const remainingQty = (item, uses) => round2(item.qty - holdingQty(item.key, uses));
const snoozed = (item, uses, today) => usesFor(item.key, uses).some((u) => u.status === 'snooze' && (u.until ?? '') > today);

/**
 * Pool items not (fully) tied to work yet, bought in the last `days` days.
 * Items admin said are still on the shelf wait until that runs out.
 */
export function openItems(items, uses, { today, days = 60 } = {}) {
  const from = addDays(today, -days);
  return items
    .filter((it) => POOL_KINDS.includes(it.kind) && (it.date ?? '') >= from && !snoozed(it, uses, today))
    .map((it) => ({ ...it, remaining: remainingQty(it, uses) }))
    .filter((it) => it.remaining > 0);
}

// Repairs in the work log (free text, so the matcher can read them).
export const isRepair = (e) => e.type === 'repair';
export const repairText = (e) => [e.itemName, e.note].filter(Boolean).join(' · ');
export function repairEntries(log, { today, days = 60 } = {}) {
  const from = addDays(today, -days);
  return log.filter((e) => isRepair(e) && e.date && e.date >= from && e.date <= today);
}

// The repairs an item could have gone into: up to a week before it was
// bought (the receipt came later) to a month after (bought ahead).
export const inWindow = (item, entry) => {
  if (!item.date || !entry.date) return false;
  const d = daysBetween(item.date, entry.date);
  return d >= -7 && d <= 30;
};

/**
 * How far a receipt has got: 'waiting' (not read yet), 'review' (the reader
 * wasn't sure: admin checks it), 'unreadable'/'error', 'read' (some lines
 * not tied to work yet) or 'matched' (every line has a place). A line has a
 * place when it's a shop cost (supplies, tools, returns), stock (being on the
 * shelf is a place), or a repair part, labor or core whose whole quantity is
 * tied to work or a truck (counted), or that admin said the shop used or is
 * still on the shelf.
 * @returns { state, placed, total, open: [{ lineId, text, why: 'doubt'|'setAside'|'noWork' }] }
 */
export function receiptMatch(receipt, uses) {
  const state0 = receipt.status ?? 'read';
  const lines = receipt.lines ?? [];
  if (state0 === 'waiting' || state0 === 'unreadable' || state0 === 'error') return { state: state0, placed: 0, total: lines.length, open: [] };
  const open = [];
  const cores = addOnLinks(receipt);
  lines.forEach((l, i) => {
    const kind = lineKind(l);
    if (!POOL_KINDS.includes(kind) || cores.absorbed.has(lineIdOf(l, i))) return;
    const mine = usesFor(itemKey(receipt.id, lineIdOf(l, i)), uses);
    const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
    const done = mine.filter((u) => COUNTED.includes(u.status)).reduce((s, u) => s + (Number(u.qty) || 0), 0);
    if (done >= qty - 1e-9 || mine.some((u) => u.status === 'snooze' && u.by === 'admin')) return;
    const why = mine.some((u) => u.status === 'doubt') ? 'doubt' : l.to === 'truck' && l.vehicleId ? 'setAside' : 'noWork';
    open.push({ lineId: lineIdOf(l, i), text: l.text ?? '', why });
  });
  const state = state0 === 'review' ? 'review' : open.length ? 'read' : 'matched';
  return { state, placed: lines.length - open.length, total: lines.length, open };
}

/**
 * When the work a receipt's parts went into was done: the repairs its lines
 * are tied to (one receipt can cover several), earliest first. A match the AI
 * wasn't sure of is `sure: false` until admin confirms it.
 * @returns [{ date, logId, vehicleId, vehicleName, text, sure }]
 */
export function receiptWork(receipt, uses, log) {
  const entryById = new Map(log.map((e) => [e.id, e]));
  const byLog = new Map();
  for (const u of uses) {
    if (u.receiptId !== receipt.id || !u.logId || !HOLDING.includes(u.status)) continue;
    const e = entryById.get(u.logId);
    if (!e?.date) continue;
    const sure = u.status !== 'doubt';
    const seen = byLog.get(e.id);
    if (seen) { seen.sure = seen.sure || sure; continue; }
    byLog.set(e.id, { date: e.date, logId: e.id, vehicleId: e.vehicleId, vehicleName: e.vehicleName ?? null, text: repairText(e), sure });
  }
  return [...byLog.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * What admin needs to look at, worst first:
 *   doubts   matches the AI wasn't sure of
 *   recent   matches the AI made on its own in the last 2 weeks (spot check)
 *   noWork   items bought 2+ weeks ago that no work explains
 *   noParts  repairs a week or more old that no item was tied to (only
 *            since the first receipt: older work had no receipts here)
 * Each use comes with its item and repair.
 */
export function auditQueue({ items, uses, log, today }) {
  const byKey = new Map(items.map((it) => [it.key, it]));
  const entryById = new Map(log.map((e) => [e.id, e]));
  const join = (u) => ({ use: u, item: byKey.get(itemKey(u.receiptId, u.lineId)) ?? null, entry: u.logId ? entryById.get(u.logId) ?? null : null });
  const newest = (a, b) => toMs(b.use.createdAt) - toMs(a.use.createdAt);
  const doubts = uses.filter((u) => u.status === 'doubt').map(join).filter((x) => x.item).sort(newest);
  const since = Date.parse(`${addDays(today, -14)}T00:00:00Z`);
  const recent = uses.filter((u) => u.status === 'auto' && toMs(u.createdAt) >= since).map(join).filter((x) => x.item).sort(newest);
  const twoWeeksAgo = addDays(today, -14);
  const noWork = openItems(items, uses, { today, days: 120 })
    .filter((it) => it.date <= twoWeeksAgo)
    .sort((a, b) => a.date.localeCompare(b.date));
  const used = new Set(uses.filter((u) => HOLDING.includes(u.status) && u.logId).map((u) => u.logId));
  const weekAgo = addDays(today, -7);
  const start = items.reduce((m, it) => (it.date && (!m || it.date < m) ? it.date : m), null);
  const noParts = !start ? [] : repairEntries(log, { today, days: 60 })
    .filter((e) => e.date >= start && e.date <= weekAgo && !used.has(e.id) && !e.noParts)
    .sort((a, b) => b.date.localeCompare(a.date));
  return { doubts, recent, noWork, noParts };
}

/**
 * How often the AI was right, for matches it made in a month ("2026-10"):
 * checked = admin looked (confirmed or rejected), right = confirmed.
 * Matches the AI made on its own that nobody changed count as unchecked.
 */
export function accuracy(uses, month) {
  const ai = uses.filter((u) => u.by === 'ai' && new Date(toMs(u.createdAt)).toISOString().slice(0, 7) === month);
  const right = ai.filter((u) => u.status === 'confirmed').length;
  const wrong = ai.filter((u) => u.status === 'rejected').length;
  return { made: ai.length, checked: right + wrong, right, unchecked: ai.filter((u) => u.status === 'auto').length };
}

/**
 * Every cost, dated, with the receipt line it came from:
 *   parts     a use of a batch tied to a truck: stock the work log used (by
 *             rule), or a repair part, labor or core tied to its work, on the
 *             work's date (bought for a truck with no repair: the purchase date)
 *   unpriced  something the work log used that no receipt covers yet (amount 0)
 *   waiting   bought and set aside for a truck, not used yet (not a cost yet)
 *   open      repair parts not tied to anything yet (no unit, not a cost yet)
 *   supplies / tools   shop costs (and returns not tied to a truck), on the
 *             purchase date; tools over SPREAD_TOOLS_OVER over 12 months
 * @returns [{ date, kind, amount, unitId, unitName, assetType, text, part,
 *   qty, logId, receiptId, lineId, by, sure }]
 */
export function costEvents({ receipts, uses, log }) {
  const out = [];
  const entryById = new Map(log.map((e) => [e.id, e]));
  const assetOf = (e) => (e?.assetType === 'trailer' ? 'trailer' : 'truck');
  const counted = uses.filter((u) => COUNTED.includes(u.status));
  const dateOf = (u) => entryById.get(u.logId)?.date ?? null;
  const ref = (lot) => ({ receiptId: lot.receiptId, lineId: lot.lineId });

  // Stock batches: each counted use, then what's set aside and not used yet.
  for (const lot of stockLots(receipts)) {
    const mine = counted.filter((u) => u.receiptId === lot.receiptId && u.lineId === lot.lineId);
    const amounts = useAmounts(lot.cost, lot.qty, mine, dateOf);
    for (const u of mine) {
      const e = entryById.get(u.logId);
      if (u.shop) { out.push({ date: e?.date ?? lot.date, kind: 'supplies', amount: amounts.get(u) ?? 0, unitId: null, text: lot.part, part: lot.part, qty: u.qty, ...ref(lot), by: u.by }); continue; }
      const unitId = u.vehicleId ?? e?.vehicleId;
      if (!unitId) continue;
      out.push({ date: e?.date ?? lot.date, kind: 'parts', amount: amounts.get(u) ?? 0, unitId, unitName: u.vehicleName ?? e?.vehicleName ?? null, assetType: u.assetType ?? assetOf(e), text: lot.part, part: lot.part, qty: u.qty, logId: e?.id ?? null, ...ref(lot), by: u.by ?? 'rule', sure: true });
    }
    const left = round2(lot.qty - holdingQty(lot.key, uses));
    if (left > 0 && lot.forIds.length && lot.unitCost != null) {
      out.push({ date: lot.date, kind: 'waiting', amount: round2(lot.unitCost * left), unitId: lot.forIds[0], text: lot.part, part: lot.part, qty: left, ...ref(lot) });
    }
  }
  // What the work log used that no batch covers.
  for (const e of log) {
    if (!e.partsUsed || !e.date) continue;
    for (const partId of Object.keys(e.partsUsed)) {
      const qty = uncovered(e, partId, uses);
      if (qty) out.push({ date: e.date, kind: 'unpriced', amount: 0, unitId: e.vehicleId, unitName: e.vehicleName ?? null, assetType: assetOf(e), text: partId, part: partId, qty, logId: e.id });
    }
  }
  // Repair parts, labor, cores, shop costs and returns.
  for (const it of receiptItems(receipts)) {
    if (it.unitCost == null) continue;
    const ref2 = { receiptId: it.receiptId, lineId: it.lineId };
    if (SHOP_KINDS.includes(it.kind) || (it.kind === 'credit' && !it.vehicleId)) {
      const kind = it.kind === 'tool' ? 'tools' : 'supplies';
      if (kind === 'tools' && it.cost > SPREAD_TOOLS_OVER && it.date) {
        let before = 0;
        for (let m = 1; m <= 12; m += 1) {
          const upTo = round2((it.cost * m) / 12);
          out.push({ date: addMonths(it.date, m - 1), kind, amount: round2(upTo - before), unitId: null, text: `${it.text} (${m} of 12)`, ...ref2 });
          before = upTo;
        }
      } else out.push({ date: it.date, kind, amount: round2(it.cost), unitId: null, text: it.text, ...ref2 });
      continue;
    }
    const mine = usesFor(it.key, counted);
    const amounts = useAmounts(it.cost, it.qty, mine, (u) => dateOf(u) ?? it.date);
    let left = it.qty;
    for (const u of mine) {
      left -= Math.min(Number(u.qty) || 0, left);
      const entry = u.logId ? entryById.get(u.logId) : null;
      const amount = amounts.get(u) ?? 0;
      if (u.shop) { out.push({ date: entry?.date ?? it.date, kind: 'supplies', amount, unitId: null, text: it.text, ...ref2, by: u.by }); continue; }
      const unitId = u.vehicleId ?? entry?.vehicleId;
      if (!unitId) continue;
      out.push({ date: entry?.date ?? it.date, kind: 'parts', amount, unitId, unitName: u.vehicleName ?? entry?.vehicleName ?? null, assetType: u.assetType ?? assetOf(entry), text: it.text, qty: u.qty, logId: entry?.id ?? null, ...ref2, by: u.by ?? 'ai', sure: true });
    }
    if (left <= 0) continue;
    const amount = round2(it.unitCost * left);
    if (it.kind === 'credit') out.push({ date: it.date, kind: 'parts', amount, unitId: it.vehicleId, unitName: null, assetType: 'truck', text: it.text, qty: left, logId: null, ...ref2, by: 'receipt', sure: true });
    else if (it.vehicleId) out.push({ date: it.date, kind: 'waiting', amount, unitId: it.vehicleId, text: it.text, qty: left, ...ref2 });
    else if (POOL_KINDS.includes(it.kind)) out.push({ date: it.date, kind: 'open', amount, unitId: null, text: it.text, qty: left, ...ref2 });
  }
  return out;
}

const addMonths = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last), 12)).toISOString().slice(0, 10);
};

/**
 * What each truck and trailer cost from `from` to `to` (dates, inclusive),
 * and what the shop spent on supplies and tools (costEvents, added up).
 * @returns { units: [{ unitId, name, assetType, total, unpriced }],
 *   shop: { supplies, tools, total }, open, waiting }  — open: repair parts
 *   not tied to anything; waiting: set aside for a truck, not used (neither
 *   is in a total); unpriced: things used that no receipt covers yet
 */
export function spending({ receipts, uses, log, from, to }) {
  const units = new Map();
  const shop = { supplies: 0, tools: 0, total: 0 };
  let open = 0;
  let waiting = 0;
  for (const ev of costEvents({ receipts, uses, log })) {
    if (!ev.date || ev.date < from || ev.date > to) continue;
    if (ev.kind === 'open') { open = round2(open + ev.amount); continue; }
    if (ev.kind === 'waiting') { waiting = round2(waiting + ev.amount); continue; }
    if (ev.kind === 'supplies' || ev.kind === 'tools') { shop[ev.kind] = round2(shop[ev.kind] + ev.amount); continue; }
    if (!units.has(ev.unitId)) units.set(ev.unitId, { unitId: ev.unitId, name: ev.unitName ?? ev.unitId, assetType: ev.assetType ?? 'truck', total: 0, unpriced: 0 });
    const u = units.get(ev.unitId);
    if (ev.unitName && u.name === ev.unitId) u.name = ev.unitName;
    if (ev.kind === 'unpriced') u.unpriced += 1;
    else u.total = round2(u.total + ev.amount);
  }
  shop.total = round2(shop.supplies + shop.tools);
  return { units: [...units.values()].filter((u) => u.total || u.unpriced).sort((a, b) => b.total - a.total), shop, open, waiting };
}

/**
 * Batches still on the shelf after OLD_STOCK_DAYS: nothing logged used them.
 * Admin ties them to work, says the shop used them, or snoozes them.
 * @returns [{ ...lot, remaining }] oldest first
 */
export function oldStock(receipts, uses, today) {
  const cutoff = addDays(today, -OLD_STOCK_DAYS);
  return stockLots(receipts)
    .filter((lot) => lot.date && lot.date <= cutoff && !snoozed(lot, uses, today))
    .map((lot) => ({ ...lot, remaining: round2(lot.qty - holdingQty(lot.key, uses)) }))
    .filter((lot) => lot.remaining > 0)
    .sort(lotOrder);
}

/**
 * A truck's share of the shop costs: each period's supplies and tools divided
 * evenly by the number of trucks. An estimate, shown apart from the truck's
 * own costs.
 * @returns [{ ...period, shop, trucks, share }]
 */
export function shopShare({ periods, events, trucks }) {
  return periods.map((p) => {
    const shop = round2(events.filter((ev) => (ev.kind === 'supplies' || ev.kind === 'tools') && ev.date && ev.date >= p.from && ev.date <= p.to).reduce((s, ev) => s + ev.amount, 0));
    return { ...p, shop, trucks, share: trucks ? round2(shop / trucks) : 0 };
  });
}
