// Pulls every vehicle and its latest odometer / engine hours from Samsara
// and writes them to Firestore. Runs in GitHub Actions on a schedule, so the
// Samsara key only ever lives in GitHub Secrets — never in the website.
//
// Env vars:
//   SAMSARA_API_KEY            (required) Samsara API token, read-only is enough
//   FIREBASE_SERVICE_ACCOUNT   (required unless --dry-run) service account JSON
//   ALLOWED_EMAILS             (optional) comma-separated emails allowed to view the site
//
// Usage:
//   node scripts/sync-samsara.mjs            # sync to Firestore
//   node scripts/sync-samsara.mjs --dry-run  # just print what would be written

const SAMSARA_BASE = 'https://api.samsara.com';
const METERS_PER_MILE = 1609.344;
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

async function fetchFleet() {
  const [vehicles, stats] = await Promise.all([
    samsaraGetAll('/fleet/vehicles'),
    samsaraGetAll('/fleet/vehicles/stats', {
      types: 'obdOdometerMeters,gpsOdometerMeters,obdEngineSeconds',
    }),
  ]);
  const statsById = new Map(stats.map((s) => [s.id, s]));

  return vehicles.map((v) => {
    const s = statsById.get(v.id) ?? {};
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
    };
  });
}

async function writeToFirestore(fleet) {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  const db = getFirestore();

  const batch = db.batch();
  for (const v of fleet) {
    batch.set(db.collection('vehicles').doc(v.id), {
      ...v,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  // Keeps the viewer allowlist in sync with the ALLOWED_EMAILS secret.
  const emails = (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  for (const email of emails) {
    batch.set(db.collection('allowedUsers').doc(email), { email });
  }

  batch.set(db.collection('meta').doc('sync'), {
    lastRun: FieldValue.serverTimestamp(),
    vehicleCount: fleet.length,
  });
  await batch.commit();
}

const fleet = await fetchFleet();
console.log(`Fetched ${fleet.length} vehicles from Samsara`);

if (dryRun) {
  console.table(
    fleet.map(({ name, year, make, model, odometerMiles, odometerSource, engineHours }) => ({
      name, year, make, model, odometerMiles, odometerSource, engineHours,
    })),
  );
} else {
  await writeToFirestore(fleet);
  console.log('Wrote fleet to Firestore');
}
