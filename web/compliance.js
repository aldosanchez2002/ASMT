// Inspection and registration for every truck and trailer: when each one
// expires and what needs doing. Plain ES module, no dependencies, shared by
// the website, the import script and the tests.
//
// One `compliance/{unitId}` doc per unit (apart from the Samsara data, which
// the sync overwrites):
//   { unitId, unitType: 'truck'|'trailer', name, plate, plateState, vin,
//     inspectionExpires: 'YYYY-MM-DD', registrationExpires: 'YYYY-MM-DD',
//     registrationState, multiYear (a registration good for several years),
//     status: 'active'|'out'|'sold', note, checkDates: [text] (dates fixed on
//     import that a person should confirm), updatedAt }
// The federal annual inspection (49 CFR 396.17) applies to every truck and
// trailer in service; registrations follow the state (Maine trailer plates
// run several years, Oklahoma and Texas renew every year).

export const DUE_DAYS = 30; // "due": act now
export const SOON_DAYS = 90; // "coming up": plan for it
// A registration more than this far out is a multi-year plate.
export const MULTI_YEAR_DAYS = 400;
export const STATUSES = ['active', 'out', 'sold'];

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const daysUntil = (date, today) => Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS);

/**
 * A date as the office writes it: "2027-03-31", "12/31/2026 TX", "03/2024".
 * A day the month doesn't have ("2/29/2027", "9/31/2027") becomes the last
 * day of that month, and `fixed` says what was written so a person can check.
 * @returns { date: 'YYYY-MM-DD'|null, fixed: string|null, state: 'TX'|'OK'|'ME'|null }
 */
export function parseSheetDate(text) {
  const s = String(text ?? '').trim();
  const state = /\bmaine\b|\bme\b/i.test(s) ? 'ME' : /\bok\b|oklahoma/i.test(s) ? 'OK' : /\btx\b|texas/i.test(s) ? 'TX' : null;
  let y; let m; let d = null;
  let hit = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (hit) [, y, m, d] = hit.map(Number);
  else if ((hit = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/))) [, m, d, y] = hit.map(Number);
  else if ((hit = s.match(/(\d{1,2})\/(\d{4})/))) [, m, y] = hit.map(Number);
  else return { date: null, fixed: null, state };
  if (!(m >= 1 && m <= 12)) return { date: null, fixed: null, state };
  const end = lastDay(y, m);
  let fixed = null;
  if (d == null) d = end; // "03/2024": the end of that month
  else if (d > end) { fixed = s.replace(/\s+(tx|ok|maine|me)\s*$/i, '').trim(); d = end; }
  return { date: `${y}-${pad(m)}-${pad(d)}`, fixed, state };
}

// Where one date stands: 'missing', 'expired', 'due' (30 days), 'soon' (90 days) or 'ok'.
export function dateStatus(expires, today) {
  if (!expires) return 'missing';
  const days = daysUntil(expires, today);
  if (days < 0) return 'expired';
  if (days <= DUE_DAYS) return 'due';
  if (days <= SOON_DAYS) return 'soon';
  return 'ok';
}

const RANK = { expired: 0, due: 1, soon: 2, missing: 3, ok: 4 };

/**
 * One unit: its inspection and registration, and the worst of the two.
 * Units out of service or sold need nothing renewed.
 * @returns { status, inspection: { expires, state, days }, registration: { expires, state, days, multiYear }, worst, group }
 *   group: 'action' (expired or due), 'soon', 'missing' (no dates on file), 'ok', 'out'
 */
export function unitCompliance(rec, today) {
  const status = STATUSES.includes(rec?.status) ? rec.status : 'active';
  const one = (expires) => ({ expires: expires ?? null, state: dateStatus(expires, today), days: expires ? daysUntil(expires, today) : null });
  const inspection = one(rec?.inspectionExpires);
  const registration = { ...one(rec?.registrationExpires), multiYear: Boolean(rec?.multiYear) || (rec?.registrationExpires ? daysUntil(rec.registrationExpires, today) > MULTI_YEAR_DAYS : false) };
  const worst = RANK[inspection.state] <= RANK[registration.state] ? inspection.state : registration.state;
  const group = status !== 'active' ? 'out' : worst === 'expired' || worst === 'due' ? 'action' : worst;
  return { status, inspection, registration, worst, group };
}

/**
 * Every unit with its compliance, worst first, then soonest, then by name.
 * @param units [{ id, name, unitType }]  trucks and trailers in the app
 * @param records { [unitId]: compliance doc }
 * @returns [{ ...unit, rec, ...unitCompliance }]
 */
export function complianceList(units, records, today) {
  const ORDER = { action: 0, soon: 1, missing: 2, ok: 3, out: 4 };
  const soonest = (x) => Math.min(...[x.inspection.days, x.registration.multiYear ? null : x.registration.days].filter((d) => d != null), Infinity);
  return units
    .map((u) => ({ ...u, rec: records[u.id] ?? null, ...unitCompliance(records[u.id], today) }))
    .sort((a, b) => ORDER[a.group] - ORDER[b.group] || soonest(a) - soonest(b)
      || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
}

// The next inspection after one is done today: a year out, at the end of the
// month (stickers run to the end of the month).
export function nextInspection(today) {
  const [y, m] = today.split('-').map(Number);
  return `${y + 1}-${pad(m)}-${pad(lastDay(y + 1, m))}`;
}
