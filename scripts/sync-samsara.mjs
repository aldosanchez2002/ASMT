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
  missingBaselines, scheduleDocs, scheduleIdsFor, schedulesVersion, validate,
} from './schedules.mjs';

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

function allowedEmails() {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Writes with admin credentials, which bypass the Firestore rules.
async function writeWithServiceAccount(fleet, staleIds, serviceAccountJson) {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');

  initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
  const db = getFirestore();

  const recordsSnap = await db.collection('serviceRecords').get();
  const records = Object.fromEntries(recordsSnap.docs.map((d) => [d.id, d.data()]));
  const baselines = missingBaselines(fleet, records);

  const batch = db.batch();
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
  for (const schedule of scheduleDocs()) {
    batch.set(db.collection('maintenanceSchedules').doc(schedule.id), schedule);
  }
  for (const email of allowedEmails()) {
    batch.set(db.collection('allowedUsers').doc(email), { email });
  }
  batch.set(db.collection('meta').doc('sync'), {
    lastRun: FieldValue.serverTimestamp(),
    vehicleCount: fleet.length,
    schedulesVersion,
  });
  await batch.commit();
  return baselines;
}

// Writes with the public web API key (see firestore-rest.mjs).
async function writeWithPublicApi(fleet, staleIds) {
  const baselines = missingBaselines(fleet, await listDocs('serviceRecords'));
  await commit([
    ...Object.entries(baselines).map(([vehicleId, items]) => mergeWrite(`serviceRecords/${vehicleId}`, {
      vehicleId,
      ...Object.fromEntries(Object.entries(items).map(([key, rec]) => [`items.\`${key}\``, rec])),
    })),
    ...fleet.map((v) => setWrite(`vehicles/${v.id}`, v, 'updatedAt')),
    ...staleIds.map((id) => deleteWrite(`vehicles/${id}`)),
    ...scheduleDocs().map((sch) => setWrite(`maintenanceSchedules/${sch.id}`, sch)),
    ...allowedEmails().map((email) => setWrite(`allowedUsers/${email}`, { email })),
    setWrite('meta/sync', { vehicleCount: fleet.length, schedulesVersion }, 'lastRun'),
  ]);
  return baselines;
}

validate();
const { active: fleet, staleIds } = await fetchFleet();
console.log(
  `Fetched ${fleet.length + staleIds.length} vehicles from Samsara: ` +
  `${fleet.length} reported in the last ${STALE_AFTER_DAYS} days, ${staleIds.length} stale (removed)`,
);
const unmatched = fleet.filter((v) => v.scheduleIds.length === 0);
if (unmatched.length) {
  console.warn(
    `No maintenance schedule matches ${unmatched.length} truck(s): ` +
    unmatched.map((v) => `${v.name} (${v.year} ${v.make} ${v.model})`).join(', '),
  );
}

if (dryRun) {
  console.table(
    fleet.map(({ name, year, make, model, odometerMiles, lastReportedAt, scheduleIds }) => ({
      name, year, make, model, odometerMiles, lastReportedAt, schedules: scheduleIds.join(' + '),
    })),
  );
} else {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  const baselines = serviceAccount
    ? await writeWithServiceAccount(fleet, staleIds, serviceAccount)
    : await writeWithPublicApi(fleet, staleIds);
  const added = Object.values(baselines).reduce((n, items) => n + Object.keys(items).length, 0);
  console.log(
    `Wrote fleet and schedules to Firestore (${serviceAccount ? 'service account' : 'public API'}); ` +
    `added ${added} baseline service record(s) for ${Object.keys(baselines).length} truck(s)`,
  );
}
