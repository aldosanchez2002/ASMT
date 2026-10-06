// Pulls every vehicle and its latest odometer / engine hours from Samsara
// and writes them to Firestore. Runs in GitHub Actions on a schedule, so the
// Samsara key only ever lives in GitHub Secrets — never in the website.
//
// Env vars:
//   SAMSARA_API_KEY            (required) Samsara API token, read-only is enough
//   FIREBASE_SERVICE_ACCOUNT   (optional) service account JSON. Without it, the
//                              script writes through Firestore's public REST API
//                              using the web config in web/firebase-config.js,
//                              which only works while the Firestore rules allow
//                              public writes (prototype mode).
//   ALLOWED_EMAILS             (optional) comma-separated emails allowed to view the site
//
// Usage:
//   node scripts/sync-samsara.mjs            # sync to Firestore
//   node scripts/sync-samsara.mjs --dry-run  # just print what would be written

import { commit, deleteWrite, listDocs, mergeWrite, setWrite } from './firestore-rest.mjs';
import {
  assignmentsDoc, dutyModels, missingBaselines, scheduleById, scheduleDocs, scheduleIdsFor,
  schedulesVersion, validate,
} from './schedules.mjs';
import { WINDOW_DAYS, classify, metricsFromReport, nextState } from './duty.mjs';

const SAMSARA_BASE = 'https://api.samsara.com';
const METERS_PER_MILE = 1609.344;
// Trucks that haven't reported in this many days are left off the site.
const STALE_AFTER_DAYS = 100;
const dryRun = process.argv.includes('--dry-run');

const apiKey = process.env.SAMSARA_API_KEY;
if (!apiKey) {
  console.error('Missing SAMSARA_API_KEY');
  process.exit(1);
}

// Follows Samsara's cursor pagination and returns every item.
async function samsaraGetAll(path, params = {}) {
  const items = [];
  let after;
  do {
    const url = new URL(path, SAMSARA_BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Samsara ${path} failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    items.push(...(body.data ?? []));
    after = body.pagination?.hasNextPage ? body.pagination.endCursor : undefined;
  } while (after);
  return items;
}

// Returns the trucks that reported recently, plus the IDs of the ones that
// haven't (so they can be removed from Firestore).
async function fetchFleet() {
  const [vehicles, odoStats, gpsStats] = await Promise.all([
    samsaraGetAll('/fleet/vehicles'),
    samsaraGetAll('/fleet/vehicles/stats', {
      types: 'obdOdometerMeters,gpsOdometerMeters,obdEngineSeconds',
    }),
    samsaraGetAll('/fleet/vehicles/stats', { types: 'gps' }),
  ]);
  const odoById = new Map(odoStats.map((s) => [s.id, s]));
  const gpsById = new Map(gpsStats.map((s) => [s.id, s]));

  const fleet = vehicles.map((v) => {
    const s = odoById.get(v.id) ?? {};
    // ECU (OBD) odometer matches the dash; GPS odometer is the fallback.
    const odo = s.obdOdometerMeters ?? s.gpsOdometerMeters;
    return {
      id: v.id,
      name: v.name ?? '',
      make: v.make ?? '',
      model: v.model ?? '',
      year: v.year ?? '',
      vin: v.vin ?? '',
      plate: v.licensePlate ?? '',
      odometerMiles: odo ? Math.round(odo.value / METERS_PER_MILE) : null,
      odometerSource: s.obdOdometerMeters ? 'obd' : s.gpsOdometerMeters ? 'gps' : null,
      odometerTime: odo?.time ?? null,
      engineHours: s.obdEngineSeconds ? Math.round(s.obdEngineSeconds.value / 3600) : null,
      lastReportedAt: gpsById.get(v.id)?.gps?.time ?? odo?.time ?? null,
      scheduleIds: scheduleIdsFor(v),
    };
  });

  const cutoff = Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const isActive = (v) => v.lastReportedAt && Date.parse(v.lastReportedAt) >= cutoff;
  return {
    active: fleet.filter(isActive),
    staleIds: fleet.filter((v) => !isActive(v)).map((v) => v.id),
  };
}

// Trailer units: latest location and tracker, split into active (reported in
// the last STALE_AFTER_DAYS) and stale.
async function fetchTrailers() {
  const [trailers, stats] = await Promise.all([
    samsaraGetAll('/fleet/trailers'),
    samsaraGetAll('/fleet/trailers/stats', { types: 'gps' }),
  ]);
  const gpsById = new Map(stats.map((s) => [s.id, s.gps]));
  const units = trailers.map((t) => {
    const gps = gpsById.get(t.id);
    return {
      id: t.id,
      name: t.name ?? '',
      trackerModel: t.installedGateway?.model ?? null,
      trackerSerial: t.installedGateway?.serial ?? null,
      latitude: gps?.latitude ?? null,
      longitude: gps?.longitude ?? null,
      location: gps?.reverseGeo?.formattedLocation ?? null,
      speedMph: gps?.speedMilesPerHour ?? null,
      lastReportedAt: gps?.time ?? null,
    };
  });
  const cutoff = Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const isActive = (c) => c.lastReportedAt && Date.parse(c.lastReportedAt) >= cutoff;
  return {
    active: units.filter(isActive),
    staleIds: units.filter((c) => !isActive(c)).map((c) => c.id),
  };
}

// Samsara fuel & energy report for the last WINDOW_DAYS: vehicleId -> metrics.
async function fetchDutyMetrics() {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const reports = [];
  let after;
  do {
    const url = new URL('/fleet/reports/vehicles/fuel-energy', SAMSARA_BASE);
    url.searchParams.set('startDate', start.toISOString());
    url.searchParams.set('endDate', end.toISOString());
    if (after) url.searchParams.set('after', after);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Samsara fuel-energy report failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    reports.push(...(body.data?.vehicleReports ?? []));
    after = body.pagination?.hasNextPage ? body.pagination.endCursor : undefined;
  } while (after);
  return new Map(reports.map((r) => [r.vehicle.id, metricsFromReport(r)]));
}

const dutyLabel = (model, duty) =>
  dutyModels[model]?.options.find((o) => o.id === duty)?.label ?? duty;

// Classifies every truck's duty cycle per duty model and applies the
// stability window. Returns the dutyCycles docs to write and log entries for
// classifications that changed (or were first set away from the default).
function classifyFleet(fleet, metricsById, existing, now = new Date()) {
  const docs = {};
  const changes = [];
  for (const v of fleet) {
    const metrics = metricsById?.get(v.id) ?? null;
    const prev = existing[v.id] ?? {};
    const models = [...new Set(v.scheduleIds.map((id) => scheduleById.get(id)?.dutyModel).filter(Boolean))];
    const current = {};
    const state = {};
    for (const model of models) {
      const candidate = classify(model, metrics, v.engineHours);
      const r = nextState(prev.state?.[model], candidate, now);
      state[model] = { ...r.state, candidate: candidate ?? null };
      if (r.state.current) current[model] = r.state.current;
      const from = r.changed ? r.from : r.initial ? dutyModels[model].default : null;
      if (from && r.state.current !== from) {
        changes.push({
          id: `duty-${v.id}-${model}-${now.getTime()}`,
          type: 'duty',
          vehicleId: v.id,
          vehicleName: v.name,
          itemName: `Duty cycle: ${dutyLabel(model, from)} → ${dutyLabel(model, r.state.current)}`,
          note: metrics
            ? `${metrics.annualMiles.toLocaleString('en-US')} mi/yr · ${metrics.mpg ?? '—'} MPG · ${metrics.idlePct ?? '—'}% idle (last ${metrics.windowDays} days)`
            : '',
          miles: v.odometerMiles,
          hours: v.engineHours ?? null,
          date: now.toISOString().slice(0, 10),
          source: 'auto',
        });
      }
    }
    docs[v.id] = { vehicleId: v.id, current, state, metrics, classifiedAt: now.toISOString() };
  }
  return { docs, changes };
}

function allowedEmails() {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Writes with admin credentials, which bypass the Firestore rules.
async function writeWithServiceAccount(fleet, staleIds, trailers, metricsById, serviceAccountJson) {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');

  initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
  const db = getFirestore();

  const recordsSnap = await db.collection('serviceRecords').get();
  const records = Object.fromEntries(recordsSnap.docs.map((d) => [d.id, d.data()]));
  const baselines = missingBaselines(fleet, records);
  const dutySnap = await db.collection('dutyCycles').get();
  const duty = metricsById
    ? classifyFleet(fleet, metricsById, Object.fromEntries(dutySnap.docs.map((d) => [d.id, d.data()])))
    : { docs: {}, changes: [] };

  const batch = db.batch();
  for (const [vehicleId, d] of Object.entries(duty.docs)) {
    // merge keeps the app's manual `override` field
    batch.set(db.collection('dutyCycles').doc(vehicleId), d, { mergeFields: Object.keys(d) });
  }
  for (const { id, ...entry } of duty.changes) {
    batch.set(db.collection('serviceLog').doc(id), { ...entry, loggedAt: FieldValue.serverTimestamp() });
  }
  for (const [vehicleId, items] of Object.entries(baselines)) {
    batch.set(db.collection('serviceRecords').doc(vehicleId), { vehicleId, items }, { merge: true });
  }
  for (const v of fleet) {
    batch.set(db.collection('vehicles').doc(v.id), {
      ...v,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  for (const id of staleIds) {
    batch.delete(db.collection('vehicles').doc(id));
  }
  for (const c of trailers.active) {
    batch.set(db.collection('trailers').doc(c.id), { ...c, updatedAt: FieldValue.serverTimestamp() });
  }
  for (const id of trailers.staleIds) {
    batch.delete(db.collection('trailers').doc(id));
  }
  for (const schedule of scheduleDocs()) {
    batch.set(db.collection('maintenanceSchedules').doc(schedule.id), schedule);
  }
  batch.set(db.collection('meta').doc('schedules'), assignmentsDoc());
  for (const email of allowedEmails()) {
    batch.set(db.collection('allowedUsers').doc(email), { email });
  }
  batch.set(db.collection('meta').doc('sync'), {
    lastRun: FieldValue.serverTimestamp(),
    vehicleCount: fleet.length,
    trailerCount: trailers.active.length,
    schedulesVersion,
  });
  await batch.commit();
  return { baselines, dutyChanges: duty.changes, dutyClassified: Object.keys(duty.docs).length };
}

// Writes with the public web API key (see firestore-rest.mjs).
async function writeWithPublicApi(fleet, staleIds, trailers, metricsById) {
  const baselines = missingBaselines(fleet, await listDocs('serviceRecords'));
  const duty = metricsById
    ? classifyFleet(fleet, metricsById, await listDocs('dutyCycles'))
    : { docs: {}, changes: [] };
  await commit([
    // updateMask leaves the app's manual `override` field alone
    ...Object.entries(duty.docs).map(([vehicleId, d]) => mergeWrite(`dutyCycles/${vehicleId}`, d)),
    ...duty.changes.map(({ id, ...entry }) => setWrite(`serviceLog/${id}`, entry, 'loggedAt')),
    ...Object.entries(baselines).map(([vehicleId, items]) => mergeWrite(`serviceRecords/${vehicleId}`, {
      vehicleId,
      ...Object.fromEntries(Object.entries(items).map(([key, rec]) => [`items.\`${key}\``, rec])),
    })),
    ...fleet.map((v) => setWrite(`vehicles/${v.id}`, v, 'updatedAt')),
    ...staleIds.map((id) => deleteWrite(`vehicles/${id}`)),
    ...trailers.active.map((c) => setWrite(`trailers/${c.id}`, c, 'updatedAt')),
    ...trailers.staleIds.map((id) => deleteWrite(`trailers/${id}`)),
    ...scheduleDocs().map((sch) => setWrite(`maintenanceSchedules/${sch.id}`, sch)),
    setWrite('meta/schedules', assignmentsDoc()),
    ...allowedEmails().map((email) => setWrite(`allowedUsers/${email}`, { email })),
    setWrite('meta/sync', {
      vehicleCount: fleet.length, trailerCount: trailers.active.length, schedulesVersion,
    }, 'lastRun'),
  ]);
  return { baselines, dutyChanges: duty.changes, dutyClassified: Object.keys(duty.docs).length };
}

validate();
const [{ active: fleet, staleIds }, trailers, metricsById] = await Promise.all([
  fetchFleet(),
  fetchTrailers(),
  // Duty classification is best-effort: if the report fails, the sync still runs.
  fetchDutyMetrics().catch((err) => { console.warn(`Skipping duty classification: ${err.message}`); return null; }),
]);
console.log(
  `Fetched ${fleet.length + staleIds.length} vehicles from Samsara: ` +
  `${fleet.length} reported in the last ${STALE_AFTER_DAYS} days, ${staleIds.length} stale (removed)`,
);
console.log(
  `Fetched ${trailers.active.length + trailers.staleIds.length} trailers: ` +
  `${trailers.active.length} active, ${trailers.staleIds.length} stale (removed)`,
);
const unmatched = fleet.filter((v) => v.scheduleIds.length === 0);
if (unmatched.length) {
  console.warn(
    `No maintenance schedule matches ${unmatched.length} truck(s): ` +
    unmatched.map((v) => `${v.name} (${v.year} ${v.make} ${v.model})`).join(', '),
  );
}

if (dryRun) {
  const { docs } = metricsById ? classifyFleet(fleet, metricsById, {}) : { docs: {} };
  console.table(
    fleet.map(({ id, name, year, make, model, odometerMiles, engineHours }) => {
      const d = docs[id];
      return {
        name, year, make, model, odometerMiles, engineHours,
        miPerYr: d?.metrics?.annualMiles, mpg: d?.metrics?.mpg, idle: d?.metrics?.idlePct,
        duty: d ? Object.entries(d.current).map(([m, x]) => `${m}:${x}`).join(' ') || 'default (not enough data)' : '—',
      };
    }),
  );
} else {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  const { baselines, dutyChanges, dutyClassified } = serviceAccount
    ? await writeWithServiceAccount(fleet, staleIds, trailers, metricsById, serviceAccount)
    : await writeWithPublicApi(fleet, staleIds, trailers, metricsById);
  console.log(`Classified duty cycles for ${dutyClassified} truck(s); ${dutyChanges.length} change(s)`);
  for (const c of dutyChanges) console.log(`  ${c.vehicleName}: ${c.itemName} (${c.note})`);
  const added = Object.values(baselines).reduce((n, items) => n + Object.keys(items).length, 0);
  console.log(
    `Wrote fleet and schedules to Firestore (${serviceAccount ? 'service account' : 'public API'}); ` +
    `added ${added} baseline service record(s) for ${Object.keys(baselines).length} truck(s)`,
  );
}
