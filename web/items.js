// Items: every line of every receipt, and where each one went.
//
// The receipt reader turns each receipt line into an item with a kind:
//   stock     a part kept on the shelf (filters, oil, tires, batteries): the
//             work log's kits and tire/battery entries use it (parts.js)
//   part      a repair part bought for a job
//   labor     outside labor (a dealer or another shop)
//   core      a core charge (it goes with the part it came with)
//   supplies  shop supplies: cleaners, rags, grease
//   tool      shop tools
//   credit    a return or credit (negative)
// Repair parts, labor and cores go to the "pool" until they're tied to the
// work they were used in: the matcher (scripts/match-items.mjs) suggests a
// repair for each one, and admin confirms or changes it. Each tie is an
// itemUses doc:
//   { receiptId, lineId, qty, logId, vehicleId, vehicleName, assetType,
//     shop, by: 'ai'|'admin', status, confidence, reason, createdAt }
// status: 'auto' (the AI was sure, counted), 'doubt' (unsure, waits for
// admin), 'confirmed' (admin said so), 'rejected' (admin said no; kept so
// the AI doesn't suggest it again), 'snooze' (admin: still on the shelf).
// Plain ES module with no dependencies, shared by the website, the scripts
// and the tests.

import { averageCost } from './parts.js';

export const POOL_KINDS = ['part', 'labor', 'core'];
export const SHOP_KINDS = ['supplies', 'tool'];
export const KINDS = ['stock', ...POOL_KINDS, ...SHOP_KINDS, 'credit'];
// Uses that hold an item (it isn't free to match again).
export const HOLDING = ['auto', 'doubt', 'confirmed'];
// Uses that count in what a truck cost.
export const COUNTED = ['auto', 'confirmed'];
// The AI ties an item to a repair on its own when at least this sure.
export const AUTO_CONFIDENCE = 85;

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

/**
 * Every non-stock line of the receipts that have been read, as items.
 * @returns [{ key, receiptId, lineId, text, partNumber, kind, qty, cost,
 *   unitCost, date, vendor, vehicleId, truckChoices, note }]
 */
export function receiptItems(receipts) {
  const out = [];
  for (const r of receipts) {
    if (r.status === 'waiting' || r.status === 'unreadable' || r.status === 'error') continue;
    (r.lines ?? []).forEach((l, i) => {
      const kind = lineKind(l);
      if (kind === 'stock') return;
      const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
      const cost = l.cost ?? (l.price == null || l.price === '' ? null : Number(l.price));
      const lineId = lineIdOf(l, i);
      out.push({
        key: itemKey(r.id, lineId), receiptId: r.id, lineId, text: l.text ?? '', partNumber: l.partNumber ?? null,
        kind, qty, cost, unitCost: cost == null ? null : cost / qty, date: r.date ?? null, vendor: r.vendor ?? '',
        vehicleId: l.to === 'truck' ? l.vehicleId ?? null : null, truckChoices: l.truckChoices ?? null, note: r.note ?? null,
      });
    });
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
 * Every cost, dated, with what it's for:
 *   shelf     shelf parts the work log used (kits, tires, batteries), at
 *             their average real cost, on the work's date
 *   items     repair parts, labor and cores tied to work (counted uses), on
 *             the work's date; tied to a truck with no repair, or bought for
 *             a truck and not tied to a repair yet, on the purchase date
 *   supplies / tools   shop costs (and returns not tied to a truck), on the
 *             purchase date
 *   open      pool items not tied to anything yet (no unit)
 * @returns [{ date, kind, amount, unitId, unitName, assetType, text, logId }]
 */
export function costEvents({ receipts, uses, log }) {
  const out = [];
  const costOf = new Map();
  const partCost = (id) => {
    if (!costOf.has(id)) costOf.set(id, averageCost(id, receipts));
    return costOf.get(id);
  };
  const assetOf = (e) => (e?.assetType === 'trailer' ? 'trailer' : 'truck');
  for (const e of log) {
    if (!e.partsUsed) continue;
    for (const [id, qty] of Object.entries(e.partsUsed)) {
      const c = partCost(id);
      if (c == null) continue;
      out.push({ date: e.date, kind: 'shelf', amount: round2(c * Number(qty)), unitId: e.vehicleId, unitName: e.vehicleName ?? null, assetType: assetOf(e), text: id, logId: e.id ?? null });
    }
  }
  const entryById = new Map(log.map((e) => [e.id, e]));
  for (const it of receiptItems(receipts)) {
    if (it.unitCost == null) continue;
    if (SHOP_KINDS.includes(it.kind) || (it.kind === 'credit' && !it.vehicleId)) {
      out.push({ date: it.date, kind: it.kind === 'tool' ? 'tools' : 'supplies', amount: round2(it.cost), unitId: null, text: it.text });
      continue;
    }
    let left = it.qty;
    for (const u of usesFor(it.key, uses).filter((x) => COUNTED.includes(x.status))) {
      const qty = Math.min(Number(u.qty) || 0, left);
      left -= qty;
      const entry = u.logId ? entryById.get(u.logId) : null;
      const amount = round2(it.unitCost * qty);
      if (u.shop) { out.push({ date: entry?.date ?? it.date, kind: 'supplies', amount, unitId: null, text: it.text }); continue; }
      const unitId = u.vehicleId ?? entry?.vehicleId;
      if (!unitId) continue;
      out.push({ date: entry?.date ?? it.date, kind: 'items', amount, unitId, unitName: u.vehicleName ?? entry?.vehicleName ?? null, assetType: u.assetType ?? assetOf(entry), text: it.text, logId: entry?.id ?? null });
    }
    if (left <= 0) continue;
    const amount = round2(it.unitCost * left);
    if (it.vehicleId) out.push({ date: it.date, kind: 'items', amount, unitId: it.vehicleId, unitName: null, assetType: 'truck', text: it.text, logId: null });
    else if (POOL_KINDS.includes(it.kind)) out.push({ date: it.date, kind: 'open', amount, unitId: null, text: it.text });
  }
  return out;
}

/**
 * What each truck and trailer cost from `from` to `to` (dates, inclusive),
 * and what the shop spent on supplies and tools (costEvents, added up).
 * @returns { units: [{ unitId, name, assetType, total, shelf, items }],
 *   shop: { supplies, tools, total }, open }  — open: pool items not yet
 *   tied to anything (not in any total)
 */
export function spending({ receipts, uses, log, from, to }) {
  const units = new Map();
  const shop = { supplies: 0, tools: 0, total: 0 };
  let open = 0;
  for (const ev of costEvents({ receipts, uses, log })) {
    if (!ev.date || ev.date < from || ev.date > to) continue;
    if (ev.kind === 'open') { open = round2(open + ev.amount); continue; }
    if (ev.kind === 'supplies' || ev.kind === 'tools') { shop[ev.kind] = round2(shop[ev.kind] + ev.amount); continue; }
    if (!units.has(ev.unitId)) units.set(ev.unitId, { unitId: ev.unitId, name: ev.unitName ?? ev.unitId, assetType: ev.assetType ?? 'truck', total: 0, shelf: 0, items: 0 });
    const u = units.get(ev.unitId);
    if (ev.unitName && u.name === ev.unitId) u.name = ev.unitName;
    u[ev.kind] = round2(u[ev.kind] + ev.amount);
  }
  for (const u of units.values()) u.total = round2(u.shelf + u.items);
  shop.total = round2(shop.supplies + shop.tools);
  return { units: [...units.values()].filter((u) => u.total).sort((a, b) => b.total - a.total), shop, open };
}
