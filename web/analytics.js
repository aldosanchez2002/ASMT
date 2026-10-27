// Analytics: one truck (or trailer), month by month or week by week — what
// it cost, how far it drove, what work it had. Plain ES module, no
// dependencies, shared by the website and the tests.

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const utc = (date) => new Date(`${date}T12:00:00Z`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The last `count` months or weeks up to `today` ("YYYY-MM-DD"), oldest first.
 * Weeks start on Monday. The current period ends today.
 * @returns [{ key, label, from, to }]
 */
export function periodsBack(today, unit, count) {
  const out = [];
  const end = utc(today);
  if (unit === 'week') {
    const monday = new Date(end.getTime() - ((end.getUTCDay() + 6) % 7) * DAY_MS);
    for (let i = count - 1; i >= 0; i -= 1) {
      const from = new Date(monday.getTime() - i * 7 * DAY_MS);
      const to = new Date(from.getTime() + 6 * DAY_MS);
      out.push({ key: iso(from), label: `${MONTHS[from.getUTCMonth()]} ${from.getUTCDate()}`, from: iso(from), to: iso(to > end ? end : to) });
    }
    return out;
  }
  for (let i = count - 1; i >= 0; i -= 1) {
    const first = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1, 12));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12));
    const key = iso(first).slice(0, 7);
    // "Jul"; January carries its year ("Jan '27") so a range across years reads right.
    const label = first.getUTCMonth() === 0 ? `Jan '${String(first.getUTCFullYear()).slice(2)}` : MONTHS[first.getUTCMonth()];
    out.push({ key, label, from: iso(first), to: iso(last > end ? end : last) });
  }
  return out;
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
 *   batteries, shelf, items, total, perMile }], totals: same fields summed }
 */
export function unitBreakdown({ unitId, periods, events, log, days = null }) {
  const mine = events.filter((ev) => ev.unitId === unitId && ev.date);
  const work = log.filter((e) => e.vehicleId === unitId && e.date && workKind(e));
  const rows = periods.map((p) => {
    const inP = (d) => d >= p.from && d <= p.to;
    const row = { ...p, miles: days ? milesIn(days, p.from, p.to) : null, service: 0, repair: 0, tires: 0, batteries: 0, shelf: 0, items: 0 };
    for (const e of work) if (inP(e.date)) row[workKind(e)] += 1;
    for (const ev of mine) if (inP(ev.date) && (ev.kind === 'shelf' || ev.kind === 'items')) row[ev.kind] = round2(row[ev.kind] + ev.amount);
    row.total = round2(row.shelf + row.items);
    row.perMile = row.miles ? round2(row.total / row.miles) : null;
    return row;
  });
  const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const miles = rows.some((r) => r.miles != null) ? sum('miles') : null;
  const total = round2(sum('total'));
  const totals = {
    miles, service: sum('service'), repair: sum('repair'), tires: sum('tires'), batteries: sum('batteries'),
    shelf: round2(sum('shelf')), items: round2(sum('items')), total, perMile: miles ? round2(total / miles) : null,
  };
  return { rows, totals };
}
