// Samsara API helpers shared by the sync and the odometer backfill. The key
// comes from SAMSARA_API_KEY (a GitHub secret); it never reaches the website.

const SAMSARA_BASE = 'https://api.samsara.com';
export const METERS_PER_MILE = 1609.344;

// Follows Samsara's cursor pagination and returns every item.
export async function samsaraGetAll(path, params = {}) {
  const apiKey = process.env.SAMSARA_API_KEY;
  if (!apiKey) throw new Error('Missing SAMSARA_API_KEY');
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

// A Samsara stats object -> { miles, hours, at } (ECU odometer first, GPS
// odometer as the fallback, the same as the vehicles list).
export function readingFromStats(s) {
  const odo = s.obdOdometerMeters ?? s.gpsOdometerMeters;
  if (!odo) return null;
  return {
    miles: Math.round(odo.value / METERS_PER_MILE),
    hours: s.obdEngineSeconds ? Math.round(s.obdEngineSeconds.value / 3600) : null,
    at: odo.time,
  };
}

// The odometerDaily field for a reading: one per truck per day (UTC date of
// the reading), later readings that day replacing earlier ones.
export const dailyField = (day) => `days.\`${day}\``;

// Samsara's faultCodes stat -> { time, lamps, codes } (J1939 trucks).
export function faultsFromStats(s) {
  const f = s.faultCodes;
  if (!f) return null;
  const j = f.j1939 ?? {};
  const l = j.checkEngineLights ?? {};
  return {
    time: f.time ?? null,
    lamps: { stop: Boolean(l.stopIsOn), warning: Boolean(l.warningIsOn), emissions: Boolean(l.emissionsIsOn), protect: Boolean(l.protectIsOn) },
    codes: (j.diagnosticTroubleCodes ?? []).map((c) => ({
      spn: c.spnId ?? null,
      fmi: c.fmiId ?? null,
      spnText: c.spnDescription ?? '',
      fmiText: c.fmiDescription ?? '',
      source: c.sourceAddressName ?? '',
      mil: c.milStatus ?? null,
      count: c.occurrenceCount ?? null,
    })),
  };
}

// Samsara's gps stat -> { lat, lon, speedMph, address, time }.
export function locationFromStats(s) {
  const g = s.gps;
  if (!g || g.latitude == null) return null;
  return {
    lat: g.latitude,
    lon: g.longitude,
    speedMph: g.speedMilesPerHour ?? 0,
    address: g.reverseGeo?.formattedLocation ?? '',
    time: g.time ?? null,
  };
}
