// Works out when each maintenance item is next due for a truck.
// Shared by the website and the tests (plain ES module, no dependencies).

const DAY_MS = 24 * 60 * 60 * 1000;

// Key used for an item in serviceRecords/{vehicleId}.items
export const recordKey = (scheduleId, itemId) => `${scheduleId}__${itemId}`;

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
 */
export function truckMaintenance(vehicle, schedules, records = {}, now = new Date()) {
  const current = { miles: vehicle.odometerMiles, hours: vehicle.engineHours, now };
  const rows = [];
  for (const scheduleId of vehicle.scheduleIds ?? []) {
    const schedule = schedules.get(scheduleId);
    if (!schedule) continue;
    for (const item of schedule.items) {
      const key = recordKey(scheduleId, item.id);
      const last = records[key];
      rows.push({ key, schedule, item, last, ...nextDue(item, last, current) });
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
