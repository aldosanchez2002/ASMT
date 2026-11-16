// Samsara API helpers shared by the sync and the odometer backfill. The keys
// come from GitHub secrets; they never reach the website. The fleet can span
// several Samsara accounts under the same administration: SAMSARA_API_KEY is
// the main one, SAMSARA_API_KEY_2 (and _3, _4, _5) the others. Their trucks
// and trailers are merged as if they were one account (Samsara IDs are
// unique across accounts).

const SAMSARA_BASE = 'https://api.samsara.com';
export const METERS_PER_MILE = 1609.344;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Samsara sometimes answers 504 / 503 / 429 for a while (and connections
// drop): try up to 4 times, waiting 30 s, 2 min, then 5 min (or what
// Retry-After says), so a short Samsara outage doesn't fail the sync.
const RETRY_WAITS_MS = [30_000, 120_000, 300_000];
export async function fetchWithRetry(url, headers, waits = RETRY_WAITS_MS) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(url, { headers });
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= waits.length) return res;
      const after = Number(res.headers.get('retry-after'));
      console.warn(`Samsara ${url.pathname}: ${res.status}, retrying (${attempt + 1}/${waits.length})`);
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 300_000) : waits[attempt]);
    } catch (err) {
      if (attempt >= waits.length) throw err;
      console.warn(`Samsara ${url.pathname}: ${err.message}, retrying (${attempt + 1}/${waits.length})`);
      await sleep(waits[attempt]);
    }
  }
}

// Every Samsara account to read: [{ n: 1, key }, { n: 2, key }, …].
export function samsaraAccounts(env = process.env) {
  return [env.SAMSARA_API_KEY, ...[2, 3, 4, 5].map((n) => env[`SAMSARA_API_KEY_${n}`])]
    .map((key, i) => ({ n: i + 1, key: (key ?? '').trim() }))
    .filter((a) => a.key);
}

/**
 * The same request to every account, the items merged, each tagged with its
 * account number (_account). The main account failing fails the call, as
 * before; another account failing is skipped with a warning, so a bad second
 * key never stops the main fleet from syncing.
 */
export async function samsaraGetAllAccounts(path, params = {}, { accounts = samsaraAccounts(), get = samsaraGetAll } = {}) {
  if (!accounts.length) throw new Error('Missing SAMSARA_API_KEY');
  const lists = await Promise.all(accounts.map(async (a) => {
    try {
      return (await get(path, params, a.key)).map((item) => ({ ...item, _account: a.n }));
    } catch (err) {
      if (a.n === 1) throw err;
      console.warn(`Samsara account ${a.n}: skipping ${path} this run: ${err.message}`);
      return [];
    }
  }));
  return lists.flat();
}

// Follows Samsara's cursor pagination and returns every item.
export async function samsaraGetAll(path, params = {}, apiKey = process.env.SAMSARA_API_KEY) {
  if (!apiKey) throw new Error('Missing SAMSARA_API_KEY');
  const items = [];
  let after;
  do {
    const url = new URL(path, SAMSARA_BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (after) url.searchParams.set('after', after);

    const res = await fetchWithRetry(url, { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' });
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
