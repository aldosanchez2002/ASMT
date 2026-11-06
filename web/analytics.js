// Analytics: one truck (or trailer), or the whole fleet, month by month or
// week by week — what it cost, how far it drove, what work it had. Plain ES module, no
// dependencies, shared by the website and the tests.

import { visitServices } from './maintenance.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const utc = (date) => new Date(`${date}T12:00:00Z`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const monthLabel = (d) => (d.getUTCMonth() === 0 ? `Jan '${String(d.getUTCFullYear()).slice(2)}` : MONTHS[d.getUTCMonth()]);

// The weeks (Monday to Sunday) touching [from, to], each cut to that range.
export function weekPeriods(from, to) {
  const out = [];
  const start = utc(from);
  const end = utc(to);
  for (let monday = new Date(start.getTime() - ((start.getUTCDay() + 6) % 7) * DAY_MS); monday <= end; monday = new Date(monday.getTime() + 7 * DAY_MS)) {
    const a = monday < start ? start : monday;
    const sunday = new Date(monday.getTime() + 6 * DAY_MS);
    const b = sunday > end ? end : sunday;
    out.push({ key: iso(a), label: `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()}`, from: iso(a), to: iso(b) });
  }
  return out;
}

// The months touching [from, to], each cut to that range. "Jul"; January
// carries its year ("Jan '27") so a range across years reads right.
export function monthPeriods(from, to) {
  const out = [];
  const start = utc(from);
  const end = utc(to);
  for (let first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1, 12)); first <= end;
    first = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1, 12))) {
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12));
    const a = first < start ? start : first;
    const b = last > end ? end : last;
    out.push({ key: iso(first).slice(0, 7), label: monthLabel(first), from: iso(a), to: iso(b) });
  }
  return out;
}

const lastDayOf = (month) => { // "2026-02" -> "2026-02-28"
  const [y, m] = month.split('-').map(Number);
  return iso(new Date(Date.UTC(y, m, 0, 12)));
};

/**
 * The periods for a date choice, never past `today`:
 *   { mode: 'month', month: 'YYYY-MM' }      that month, week by week
 *   { mode: 'year', year: 'YYYY' }           that year, month by month
 *   { mode: 'range', from, to }              week by week up to ~2 months, else month by month
 *   { mode: 'all' }                          since `first` (the first record), month by month
 * @returns { grain: 'week'|'month', from, to, periods: [{ key, label, from, to }] }
 *   (no periods when the choice is all in the future)
 */
export function periodsFor(choice, today, first = today) {
  let from;
  let to;
  let grain = 'month';
  if (choice.mode === 'month') {
    from = `${choice.month}-01`;
    to = lastDayOf(choice.month);
    grain = 'week';
  } else if (choice.mode === 'year') {
    from = `${choice.year}-01-01`;
    to = `${choice.year}-12-31`;
  } else if (choice.mode === 'range') {
    [from, to] = [choice.from, choice.to].sort();
    grain = (utc(to) - utc(from)) / DAY_MS <= 62 ? 'week' : 'month';
  } else {
    from = (first && first < today ? first : today).slice(0, 7) + '-01';
    to = today;
  }
  if (to > today) to = today;
  if (!from || !to || from > to) return { grain, from, to, periods: [] };
  return { grain, from, to, periods: grain === 'week' ? weekPeriods(from, to) : monthPeriods(from, to) };
}

// What a work log entry was (duty-cycle changes aren't work).
export function workKind(e) {
  if (e.type === 'duty') return null;
  if (e.type === 'repair') return 'repair';
  if (e.type === 'tires' || e.tires?.length) return 'tires';
  if (e.type === 'batteries' || e.batteries) return 'batteries';
  return 'service';
}

/**
 * Miles driven in [from, to] from daily odometer readings
 * ({ "YYYY-MM-DD": { miles } }): the last reading by `to` minus the last
 * one before `from` (or the first one in the period). Null with no readings.
 */
export function milesIn(days, from, to) {
  const dates = Object.keys(days ?? {}).filter((d) => Number(days[d]?.miles) > 0).sort();
  const endDate = dates.filter((d) => d <= to).at(-1);
  const startDate = dates.filter((d) => d < from).at(-1) ?? dates.find((d) => d >= from && d <= to);
  if (!endDate || !startDate || endDate < from) return null;
  const miles = Number(days[endDate].miles) - Number(days[startDate].miles);
  return miles >= 0 ? Math.round(miles) : null;
}

/**
 * One unit, period by period.
 * @param events costEvents (web/items.js)
 * @param log serviceLog entries
 * @param days the unit's odometerDaily days (trucks), or null
 * @returns { rows: [{ key, label, from, to, miles, service, repair, tires,
 *   batteries, parts, unpriced, total, perMile }], totals: same fields summed }
 *   (parts: what its work used, each from a receipt; unpriced: how many
 *   things it used that no receipt covers yet)
 */
export function unitBreakdown({ unitId, periods, events, log, days = null }) {
  const mine = events.filter((ev) => ev.unitId === unitId && ev.date);
  const work = log.filter((e) => e.vehicleId === unitId && e.date && workKind(e));
  const rows = periods.map((p) => {
    const inP = (d) => d >= p.from && d <= p.to;
    const row = { ...p, miles: days ? milesIn(days, p.from, p.to) : null, service: 0, repair: 0, tires: 0, batteries: 0, parts: 0, unpriced: 0 };
    for (const e of work) if (inP(e.date)) row[workKind(e)] += 1;
    for (const ev of mine) {
      if (!inP(ev.date)) continue;
      if (ev.kind === 'parts') row.parts = round2(row.parts + ev.amount);
      if (ev.kind === 'unpriced') row.unpriced += 1;
    }
    row.total = row.parts;
    row.perMile = row.miles ? round2(row.total / row.miles) : null;
    return row;
  });
  const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const miles = rows.some((r) => r.miles != null) ? sum('miles') : null;
  const total = round2(sum('total'));
  const totals = {
    miles, service: sum('service'), repair: sum('repair'), tires: sum('tires'), batteries: sum('batteries'),
    parts: round2(sum('parts')), unpriced: sum('unpriced'), total, perMile: miles ? round2(total / miles) : null,
  };
  return { rows, totals };
}

/**
 * The whole fleet, period by period: every truck's and trailer's costs and
 * work, plus the shop's supplies and tools, and the miles of every truck
 * with readings. Also each unit's totals, biggest spend first.
 * includeShop false leaves the fleet-wide costs (shop supplies and tools)
 * out of the totals; `shop` still says what they were.
 * @param units [{ id, name, trailer }]
 * @param daysById vehicleId -> odometerDaily days (trucks with readings)
 * @returns { rows: [{ ...unitBreakdown row, shop, units: [{ id, name, total }] }],
 *   totals: same sums plus shop, byUnit: [{ id, name, trailer, ...totals }] }
 */
export function fleetBreakdown({ units, periods, events, log, daysById = {}, includeShop = true }) {
  const each = units.map((u) => ({ ...u, ...unitBreakdown({ unitId: u.id, periods, events, log, days: u.trailer ? null : daysById[u.id] ?? null }) }));
  // Costs and work for units no longer in the list still count fleet-wide.
  const known = new Set(units.map((u) => u.id));
  const others = { rows: unitBreakdown({ unitId: null, periods, events: events.filter((ev) => ev.unitId && !known.has(ev.unitId)).map((ev) => ({ ...ev, unitId: null })), log: log.filter((e) => e.vehicleId && !known.has(e.vehicleId)).map((e) => ({ ...e, vehicleId: null })) }).rows };
  const shopOf = (p) => round2(events.filter((ev) => !ev.unitId && (ev.kind === 'supplies' || ev.kind === 'tools') && ev.date >= p.from && ev.date <= p.to).reduce((s, ev) => s + ev.amount, 0));
  const rows = periods.map((p, i) => {
    const parts = [...each.map((u) => u.rows[i]), others.rows[i]];
    const add = (k) => parts.reduce((s, r) => s + (r[k] ?? 0), 0);
    const miles = parts.some((r) => r.miles != null) ? add('miles') : null;
    const shop = shopOf(p);
    const row = {
      ...p, miles, service: add('service'), repair: add('repair'), tires: add('tires'), batteries: add('batteries'),
      parts: round2(add('parts')), unpriced: add('unpriced'), shop,
    };
    row.total = round2(row.parts + (includeShop ? shop : 0));
    row.perMile = miles ? round2(row.total / miles) : null;
    row.units = each.map((u) => ({ id: u.id, name: u.name, trailer: u.trailer, total: u.rows[i].total })).filter((u) => u.total).sort((a, b) => b.total - a.total);
    return row;
  });
  const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const miles = rows.some((r) => r.miles != null) ? sum('miles') : null;
  const total = round2(sum('total'));
  const totals = {
    miles, service: sum('service'), repair: sum('repair'), tires: sum('tires'), batteries: sum('batteries'),
    parts: round2(sum('parts')), unpriced: sum('unpriced'), shop: round2(sum('shop')), total, perMile: miles ? round2(total / miles) : null,
    reporting: each.filter((u) => u.totals.miles != null).length,
  };
  const work = (t) => t.service + t.repair + t.tires + t.batteries;
  const byUnit = each.map((u) => ({ id: u.id, name: u.name, trailer: u.trailer, ...u.totals, work: work(u.totals) }))
    .sort((a, b) => b.total - a.total || b.work - a.work);
  return { rows, totals, byUnit };
}

/**
 * The months for the trend chart: the chosen periods when they're already
 * months (3 or more), otherwise the 12 months ending with the chosen dates.
 */
export function trendMonths({ grain, periods, to }) {
  if (grain === 'month' && periods.length >= 3) return periods;
  const [y, m] = to.split('-').map(Number);
  return monthPeriods(iso(new Date(Date.UTC(y, m - 12, 1, 12))), to);
}

// What the money went to, in the order they're listed when tied:
// maintenance (work that reset a maintenance schedule item, the miles
// reminders), repairs (every other job, and parts tied to no logged work),
// the shop's supplies and tools, paperwork fees, and parts on hand (receipt
// items not tied to any work yet).
export const SPEND_KINDS = [
  ['maintenance', 'Maintenance'], ['repair', 'Repairs'], ['shop', 'Shop supplies'], ['paperwork', 'Inspection & registrations'], ['onhand', 'Parts on hand'],
];

/**
 * Spending in [from, to] by what it went to: each unit cost by the kind of
 * work that used it (or registration and inspection fees), then the shop's
 * supplies and tools, and the parts on hand (unmatched receipt items).
 * unitId: one unit's costs (no shop costs or parts on hand); left out: every
 * unit's, plus the shop's when includeShop, plus the parts on hand.
 * @returns [{ key, label, amount }] biggest first, no zeros
 */
export function spendByKind({ events, log, from, to, unitId, includeShop = true }) {
  const byId = new Map(log.map((e) => [e.id, e]));
  const sums = new Map();
  const add = (k, n) => sums.set(k, round2((sums.get(k) ?? 0) + n));
  for (const ev of events) {
    if (!ev.date || ev.date < from || ev.date > to) continue;
    if (ev.kind === 'parts' && (unitId === undefined ? ev.unitId : ev.unitId === unitId)) {
      const entry = ev.logId ? byId.get(ev.logId) : null;
      add(ev.paperwork ? 'paperwork' : entry && visitServices(entry).length ? 'maintenance' : 'repair', ev.amount);
    } else if (unitId === undefined && includeShop && !ev.unitId && (ev.kind === 'supplies' || ev.kind === 'tools')) add('shop', ev.amount);
    else if (unitId === undefined && ev.kind === 'open') add('onhand', ev.amount);
  }
  const order = SPEND_KINDS.map(([k]) => k);
  return SPEND_KINDS.map(([key, label]) => ({ key, label, amount: sums.get(key) ?? 0 }))
    .filter((x) => x.amount > 0)
    .sort((a, b) => b.amount - a.amount || order.indexOf(a.key) - order.indexOf(b.key));
}

/**
 * Pie slices: the biggest items, the rest folded into one "others" slice so
 * there are never more than `max`; `pinned` slices (fleet-wide costs) always
 * show, last. Items: [{ id, label, amount }].
 */
export function pieSlices(items, { max = 8, pinned = [] } = {}) {
  const keep = pinned.filter((p) => p.amount > 0);
  const sorted = items.filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount);
  const room = max - keep.length;
  if (sorted.length <= room) return [...sorted, ...keep];
  const top = sorted.slice(0, room - 1);
  const rest = sorted.slice(room - 1);
  const other = { id: 'other', label: `${rest.length} others`, amount: round2(rest.reduce((s, x) => s + x.amount, 0)), other: true, count: rest.length };
  return [...top, other, ...keep];
}

/**
 * Receipt items bought in [from, to] that aren't tied to any work or to the
 * shop yet (costEvents' 'open'), biggest first.
 * @returns { total, count, items: [event] }
 */
export function unmatchedItems(events, from, to) {
  const items = events.filter((ev) => ev.kind === 'open' && ev.date && ev.date >= from && ev.date <= to).sort((a, b) => b.amount - a.amount);
  return { total: round2(items.reduce((s, ev) => s + ev.amount, 0)), count: items.length, items };
}
