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

  const batch = db.batch();
  for (const v of fleet) {
    batch.set(db.collection('vehicles').doc(v.id), {
      ...v,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  for (const id of staleIds) {
    batch.delete(db.collection('vehicles').doc(id));
  }
  for (const email of allowedEmails()) {
    batch.set(db.collection('allowedUsers').doc(email), { email });
  }
  batch.set(db.collection('meta').doc('sync'), {
    lastRun: FieldValue.serverTimestamp(),
    vehicleCount: fleet.length,
  });
  await batch.commit();
}

// Converts a plain JS value to Firestore's REST value format.
function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  return { stringValue: String(value) };
}

// Writes with the public web API key. Firestore treats this as an
// unauthenticated request, so the rules must allow public writes.
async function writeWithPublicApi(fleet, staleIds) {
  const { firebaseConfig } = await import('../web/firebase-config.js');
  const { projectId, apiKey: webApiKey } = firebaseConfig;
  const docsPath = `projects/${projectId}/databases/(default)/documents`;

  const setDoc = (path, data, timestampField) => ({
    update: {
      name: `${docsPath}/${path}`,
      fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFirestoreValue(v)])),
    },
    updateTransforms: [{ fieldPath: timestampField, setToServerValue: 'REQUEST_TIME' }],
  });

  const writes = [
    ...fleet.map((v) => setDoc(`vehicles/${v.id}`, v, 'updatedAt')),
    ...staleIds.map((id) => ({ delete: `${docsPath}/vehicles/${id}` })),
    ...allowedEmails().map((email) => ({
      update: { name: `${docsPath}/allowedUsers/${email}`, fields: { email: toFirestoreValue(email) } },
    })),
    setDoc('meta/sync', { vehicleCount: fleet.length }, 'lastRun'),
  ];

  // A single commit is atomic and accepts up to 500 writes.
  for (let i = 0; i < writes.length; i += 500) {
    const res = await fetch(
      `https://firestore.googleapis.com/v1/${docsPath}:commit?key=${webApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writes: writes.slice(i, i + 500) }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      const hint = res.status === 403
        ? '\nFirestore rules are blocking public writes. Either allow them, or add a FIREBASE_SERVICE_ACCOUNT secret.'
        : '';
      throw new Error(`Firestore write failed: ${res.status} ${body}${hint}`);
    }
  }
}

const { active: fleet, staleIds } = await fetchFleet();
console.log(
  `Fetched ${fleet.length + staleIds.length} vehicles from Samsara: ` +
  `${fleet.length} reported in the last ${STALE_AFTER_DAYS} days, ${staleIds.length} stale (removed)`,
);

if (dryRun) {
  console.table(
    fleet.map(({ name, year, make, model, odometerMiles, engineHours, lastReportedAt }) => ({
      name, year, make, model, odometerMiles, engineHours, lastReportedAt,
    })),
  );
} else {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccount) {
    await writeWithServiceAccount(fleet, staleIds, serviceAccount);
    console.log('Wrote fleet to Firestore (service account)');
  } else {
    await writeWithPublicApi(fleet, staleIds);
    console.log('Wrote fleet to Firestore (public API, no service account)');
  }
}
