// Analytics: one truck (or trailer), month by month or week by week — what
// it cost, how far it drove, what work it had. Plain ES module, no
// dependencies, shared by the website and the tests.

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
