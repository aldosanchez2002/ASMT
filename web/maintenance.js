// Works out when each maintenance item is next due for a truck.
// Shared by the website and the tests (plain ES module, no dependencies).

const DAY_MS = 24 * 60 * 60 * 1000;

// Key used for an item in serviceRecords/{vehicleId}.items
export const recordKey = (scheduleId, itemId) => `${scheduleId}__${itemId}`;

// Item keys a service log entry (a visit) counts as done. Visits store
// `services`; older entries used `itemKeys` (paper log import) or one
// `scheduleId` + `itemId` (Mark done).
export function visitServices(entry) {
  if (Array.isArray(entry.services)) return entry.services;
  if (Array.isArray(entry.itemKeys)) return entry.itemKeys;
  if (entry.scheduleId && entry.itemId) return [recordKey(entry.scheduleId, entry.itemId)];
  return [];
}

// The later of two services: higher miles wins (a truck's miles only go up),
// then the later date.
export function isLaterService(a, b) {
  if (!b) return true;
  if (a.miles !== b.miles) return a.miles > b.miles;
  return (a.date ?? '') > (b.date ?? '');
}

/**
 * When each item was last done on one truck, worked out from its visits: the
 * latest visit that covered the item, else the item's tracking start (the
 * launch-day "treat as done" point the sync writes). The log is the source of
 * truth; nothing else stores "last done".
 * @param visits          the truck's serviceLog entries
 * @param trackingStarts  serviceRecords/{vehicleId}.items; only `source: 'baseline'` entries are used
 * @returns { [recordKey]: { miles, hours, date, source: 'done' | 'baseline', note?, visitId? } }
 */
export function lastDoneFrom(visits = [], trackingStarts = {}) {
  const out = {};
  for (const [key, rec] of Object.entries(trackingStarts ?? {})) {
    if (rec?.source === 'baseline') out[key] = rec;
  }
  const latest = {};
  for (const visit of visits) {
    // Visits without miles stay in the history but can't set a due point.
    if (visit.type === 'duty' || visit.miles == null) continue;
    for (const key of visitServices(visit)) {
      if (isLaterService(visit, latest[key])) latest[key] = visit;
    }
  }
  for (const [key, v] of Object.entries(latest)) {
    out[key] = {
      miles: v.miles, hours: v.hours ?? null, date: v.date ?? null, source: 'done', note: v.note ?? '', visitId: v.id ?? null,
    };
  }
  return out;
}

// Whether a truck falls under an assignment rule's { make, model, yearMin, yearMax }.
// Model matching is "contains", so "NEW CASCADIA 126\" SLEEPERCAB" matches CASCADIA.
// Shared by the sync (scripts/schedules.mjs) and the site's Schedules tab.
export function matchesRule(vehicle, match) {
  const year = Number(vehicle.year);
  return String(vehicle.make ?? '').toUpperCase() === match.make
    && String(vehicle.model ?? '').toUpperCase().includes(match.model)
    && year >= match.yearMin
    && year <= match.yearMax;
}

// Fleet setup: setting id -> value, starting from each setting's default.
export function effectiveSettings(definitions = [], saved = {}) {
  return Object.fromEntries(definitions.map((d) => [d.id, saved?.[d.id] ?? d.default]));
}

const matches = (when, settings) => Object.entries(when).every(([k, v]) => settings[k] === v);

// Rounds an adjusted mileage to a sensible shop number (nearest 500 mi).
const roundMiles = (n) => Math.round(n / 500) * 500;

// Applies field overrides; a null value removes the field.
function applyOverrides(item, overrides) {
  const out = { ...item, ...overrides };
  for (const [k, v] of Object.entries(overrides)) if (v === null) delete out[k];
  return out;
}

// A schedule's items for one truck:
//  1. drops items whose `onlyWhen` doesn't match the fleet setup,
//  2. applies the truck's duty cycle (`byDuty[duty]` overrides the base,
//     which is the schedule's default duty cycle),
//  3. applies the first fleet-setup `variant` whose `when` matches. A variant
//     can override fields, `scale` the interval (e.g. 0.5) or `addMiles`.
// Resolved items carry `adjusted: true` when a fleet-setup variant applied.
export function resolveItems(schedule, settings = {}, duty = null) {
  return schedule.items
    .filter((item) => !item.onlyWhen || matches(item.onlyWhen, settings))
    .map((item) => {
      const { variants, onlyWhen, byDuty, ...base } = item;
      let resolved = duty && byDuty?.[duty] ? applyOverrides(base, byDuty[duty]) : base;
      const variant = variants?.find((v) => matches(v.when, settings));
      if (!variant) return resolved;
      const { when, scale, addMiles, ...overrides } = variant;
      resolved = applyOverrides(resolved, overrides);
      if (scale) {
        if (resolved.intervalMiles) resolved.intervalMiles = roundMiles(resolved.intervalMiles * scale);
        if (resolved.intervalHours) resolved.intervalHours = Math.round(resolved.intervalHours * scale);
      }
      if (addMiles && resolved.intervalMiles) resolved.intervalMiles += addMiles;
      return { ...resolved, adjusted: true };
    });
}

// The duty cycle to use for a schedule on a truck: a manual override, else
// the automatic classification, else the schedule's default.
export function dutyFor(schedule, dutyModels, dutyDoc) {
  const model = schedule.dutyModel && dutyModels?.[schedule.dutyModel];
  if (!model) return null;
  return dutyDoc?.override?.[schedule.dutyModel] ?? dutyDoc?.current?.[schedule.dutyModel] ?? model.default;
}

function addMonths(isoDate, months) {
  const d = new Date(isoDate);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

// "Due soon" thresholds: 10% of the interval (at least 2,500 mi), 30 days.
const soonMiles = (interval) => Math.max(2500, interval * 0.1);
const soonHours = (interval) => interval * 0.1;
const SOON_DAYS = 30;

/**
 * @param item     schedule item ({ intervalMiles, intervalHours, intervalMonths, firstDueMiles, ... })
 * @param last     last service record ({ miles, hours, date, source }) or undefined
 * @param current  truck's current state ({ miles, hours, now: Date })
 * @returns { status, dueMiles, dueHours, dueDate, milesLeft, hoursLeft, daysLeft, urgency }
 *   status: 'overdue' | 'soon' | 'ok' | 'done' | 'n/a' | 'as-needed' | 'no-record'
 *   urgency: smallest fraction of an interval remaining (lower = sooner), for sorting
 */
export function nextDue(item, last, current) {
  const hasInterval = item.intervalMiles || item.intervalHours || item.intervalMonths;
  if (!hasInterval && !item.firstDueMiles) return { status: 'as-needed', urgency: Infinity };
  if (!last) return { status: 'no-record', urgency: Infinity };

  const result = { urgency: Infinity };
  const levels = [];

  // Miles. A first-due mileage applies only until the first real service is logged.
  let dueMiles;
  if (item.firstDueMiles && last.source === 'baseline' && last.miles < item.firstDueMiles) {
    dueMiles = item.firstDueMiles;
  } else if (item.intervalMiles) {
    dueMiles = last.miles + item.intervalMiles;
  } else if (item.firstDueMiles) {
    // One-time item: either it was logged as done, or the truck was already past it.
    return { status: last.source === 'baseline' ? 'n/a' : 'done', urgency: Infinity };
  }
  if (dueMiles != null && current.miles != null) {
    const interval = item.intervalMiles || item.firstDueMiles;
    result.dueMiles = dueMiles;
    result.milesLeft = dueMiles - current.miles;
    result.urgency = Math.min(result.urgency, result.milesLeft / interval);
    levels.push(result.milesLeft < 0 ? 2 : result.milesLeft <= soonMiles(interval) ? 1 : 0);
  }

  if (item.intervalHours && last.hours != null && current.hours != null) {
    result.dueHours = last.hours + item.intervalHours;
    result.hoursLeft = result.dueHours - current.hours;
    result.urgency = Math.min(result.urgency, result.hoursLeft / item.intervalHours);
    levels.push(result.hoursLeft < 0 ? 2 : result.hoursLeft <= soonHours(item.intervalHours) ? 1 : 0);
  }

  if (item.intervalMonths && last.date) {
    const dueDate = addMonths(last.date, item.intervalMonths);
    result.dueDate = dueDate.toISOString().slice(0, 10);
    result.daysLeft = Math.floor((dueDate - current.now) / DAY_MS);
    result.urgency = Math.min(result.urgency, result.daysLeft / (item.intervalMonths * 30.4));
    levels.push(result.daysLeft < 0 ? 2 : result.daysLeft <= SOON_DAYS ? 1 : 0);
  }

  const worst = Math.max(0, ...levels);
  result.status = ['ok', 'soon', 'overdue'][worst];
  return result;
}

/**
 * Every item that applies to a truck, with its due status, most urgent first.
 * @param vehicle    vehicles doc ({ id, odometerMiles, engineHours, scheduleIds })
 * @param schedules  Map of scheduleId -> maintenanceSchedules doc
 * @param records    serviceRecords doc's `items` map (or undefined)
 * @param settings   fleet setup (see effectiveSettings)
 * @param dutyModels dutyModels from meta/schedules
 * @param dutyDoc    dutyCycles/{vehicleId} doc ({ current, override })
 */
export function truckMaintenance(
  vehicle, schedules, records = {}, now = new Date(), settings = {}, dutyModels = {}, dutyDoc = null,
) {
  const current = { miles: vehicle.odometerMiles, hours: vehicle.engineHours, now };
  const rows = [];
  for (const scheduleId of vehicle.scheduleIds ?? []) {
    const schedule = schedules.get(scheduleId);
    if (!schedule) continue;
    const duty = dutyFor(schedule, dutyModels, dutyDoc);
    for (const item of resolveItems(schedule, settings, duty)) {
      const key = recordKey(scheduleId, item.id);
      const last = records[key];
      rows.push({ key, schedule, duty, item, last, ...nextDue(item, last, current) });
    }
  }
  return rows.sort((a, b) => a.urgency - b.urgency);
}

const RANK = { overdue: 0, soon: 1, ok: 2 };

// The single most urgent actionable item for a truck (for the fleet table).
export function mostUrgent(rows) {
  return rows
    .filter((r) => r.status in RANK)
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.urgency - b.urgency)[0];
}
