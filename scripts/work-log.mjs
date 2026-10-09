// Turns a typed-up paper work log into Firestore changes: one service log
// entry per line, the latest matching service as each item's record, local
// trucks that Samsara doesn't know about, and out-of-service flags.
// Pure planning only; scripts/seed-work-log.mjs does the reading and writing.
//
// Work log file (JSON):
// {
//   "localTrucks":  [{ "name": "A06", "note": "Local truck" }],
//   "outOfService": [{ "name": "T-15", "reason": "Engine overhaul", "since": "2026-10-09" }],
//   "entries": [{
//     "unit": "T-23", "date": "2026-05-01" | null, "miles": 629123 | null,
//     "work": "Oil change",                 // short English description (shown in the app)
//     "written": "Oil change next → 654,123", // the line as written in the log
//     "services": ["oil", "fuelFilters"],   // what it counts as done (SERVICE_ITEMS)
//     "repair": false,                      // true for repairs (shown with a Repair label)
//     "note": "optional extra note"
//   }]
// }

import { recordKey, scheduleById } from './schedules.mjs';

// What each service tag counts as done, by schedule item id. Only the items a
// truck's schedules actually have are used (e.g. Freightliner has no air filter item).
export const SERVICE_ITEMS = {
  oil: ['oil'],
  fuelFilters: ['fuel-filter-engine', 'fuel-filter-frame', 'fuel-filter-engine-noframe', 'fuel-filter'],
  chassisPm: ['m1', 'pm-a', 'pm-15k'],
  airFilter: ['air-filter', 'air-cleaner'],
  airDryer: ['air-dryer-coalescing'],
};

export const LOG_ID_PREFIX = 'worklog-';
export const LOCAL_ID_PREFIX = 'local-';
const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const localVehicleId = (name) => `${LOCAL_ID_PREFIX}${slug(name)}`;
// Stable ids so a re-run replaces the same documents instead of adding copies.
export const logEntryId = (entry, index) => `${LOG_ID_PREFIX}${String(index + 1).padStart(3, '0')}-${slug(entry.unit)}`;

// Record keys ({scheduleId}__{itemId}) an entry's services cover on a truck.
export function itemKeysFor(vehicle, services = []) {
  const keys = [];
  for (const scheduleId of vehicle.scheduleIds ?? []) {
    const schedule = scheduleById.get(scheduleId);
    for (const tag of services) {
      for (const itemId of SERVICE_ITEMS[tag] ?? []) {
        if (schedule?.items.some((i) => i.id === itemId)) keys.push(recordKey(scheduleId, itemId));
      }
    }
  }
  return keys;
}

// The later of two services: higher miles wins (a truck's miles only go up),
// then the later date.
function isLater(a, b) {
  if (!b) return true;
  if (a.miles !== b.miles) return a.miles > b.miles;
  return (a.date ?? '') > (b.date ?? '');
}

/**
 * @param log       parsed work log file
 * @param vehicles  { id: vehicles doc } from Firestore
 * @param records   { vehicleId: serviceRecords doc } from Firestore
 * @param status    { vehicleId: vehicleStatus doc } from Firestore
 * @returns {{ problems, logEntries, recordChanges, localVehicles, statusDocs }}
 *   recordChanges: [{ vehicleId, vehicleName, key, before, after }]
 */
export function planWorkLog(log, vehicles, records, status = {}) {
  const problems = [];
  const byName = new Map(Object.values(vehicles).filter((v) => !v.local).map((v) => [v.name, v]));

  // Local trucks: kept in `vehicles` with no Samsara id, miles from their latest logged service.
  const localVehicles = {};
  for (const t of log.localTrucks ?? []) {
    if (byName.has(t.name)) {
      problems.push(`${t.name} is listed as a local truck but is in Samsara; using the Samsara truck`);
      continue;
    }
    const id = localVehicleId(t.name);
    const latest = (log.entries ?? [])
      .filter((e) => e.unit === t.name && e.miles != null)
      .reduce((a, e) => (isLater(e, a) ? e : a), null);
    localVehicles[id] = {
      ...(vehicles[id] ?? {}),
      id,
      name: t.name,
      local: true,
      note: t.note ?? null,
      year: vehicles[id]?.year ?? null,
      make: vehicles[id]?.make ?? null,
      model: vehicles[id]?.model ?? null,
      scheduleIds: vehicles[id]?.scheduleIds ?? [],
      odometerMiles: latest?.miles ?? null,
      odometerTime: latest?.date ?? null,
      odometerSource: 'work log',
    };
  }
  const truckFor = (name) => byName.get(name) ?? localVehicles[localVehicleId(name)];

  const logEntries = {};
  const latestByKey = new Map(); // `${vehicleId}|${key}` -> { vehicle, key, entry }
  (log.entries ?? []).forEach((entry, index) => {
    const v = truckFor(entry.unit);
    if (!v) {
      problems.push(`Line ${index + 1}: no truck named ${entry.unit} in Samsara or the local trucks; skipped`);
      return;
    }
    const keys = itemKeysFor(v, entry.services);
    const id = logEntryId(entry, index);
    logEntries[id] = {
      vehicleId: v.id,
      vehicleName: v.name,
      date: entry.date ?? null,
      miles: entry.miles ?? null,
      hours: null,
      itemName: entry.work,
      itemKeys: keys,
      note: [`Paper log: ${entry.written}`, entry.note].filter(Boolean).join(' · '),
      source: 'worklog',
      ...(entry.repair ? { type: 'repair' } : {}),
    };
    if (entry.services?.length && entry.miles == null) {
      problems.push(`Line ${index + 1} (${entry.unit} ${entry.work}): no miles, so it's in the log but doesn't update what's due`);
      return;
    }
    for (const key of keys) {
      const k = `${v.id}|${key}`;
      if (isLater(entry, latestByKey.get(k)?.entry)) latestByKey.set(k, { vehicle: v, key, entry });
    }
  });

  // Each item's record becomes its latest logged service, replacing the
  // launch-day tracking start. A newer "Mark done" from the app is kept.
  const recordChanges = [];
  for (const { vehicle, key, entry } of latestByKey.values()) {
    const before = records[vehicle.id]?.items?.[key] ?? null;
    const markedInApp = before?.source === 'done' && !before.fromWorkLog;
    if (markedInApp && !isLater(entry, before)) continue;
    const after = {
      miles: entry.miles,
      hours: null,
      date: entry.date ?? null,
      source: 'done',
      note: `Paper log: ${entry.work}`,
      fromWorkLog: true,
    };
    recordChanges.push({ vehicleId: vehicle.id, vehicleName: vehicle.name, key, before, after });
  }

  const statusDocs = {};
  for (const s of log.outOfService ?? []) {
    const v = truckFor(s.name);
    if (!v) {
      problems.push(`Out of service: no truck named ${s.name}; skipped`);
      continue;
    }
    statusDocs[v.id] = {
      ...(status[v.id] ?? {}),
      vehicleId: v.id,
      vehicleName: v.name,
      outOfService: true,
      reason: s.reason ?? 'Out of service',
      since: s.since ?? null,
    };
  }

  return { problems, logEntries, recordChanges, localVehicles, statusDocs };
}
