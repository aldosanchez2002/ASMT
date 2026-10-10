// What Samsara tells us beyond miles: engine fault lamps and codes, whether a
// truck is parked in the yard, and whether its Samsara device has gone quiet.
// Plain ES module, shared by the site and the tests.

// The shop yard on Windermere Ave, El Paso (centre of where the trucks park).
export const SHOP = { name: 'Shop · Windermere Ave', lat: 31.75555, lon: -106.236, radiusM: 250 };
export const QUIET_DAYS = 3;

// Distance in metres between two points (haversine).
export function distanceM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Parked in the yard: within the yard radius and not driving.
export function atShop(location, shop = SHOP) {
  if (location?.lat == null || location?.lon == null) return false;
  return distanceM(location, shop) <= shop.radiusM && (location.speedMph ?? 0) < 3;
}

// Whole days since Samsara last heard from the truck (null if never).
export function quietDays(lastReportedAt, now = new Date()) {
  if (!lastReportedAt) return null;
  return Math.floor((now - Date.parse(lastReportedAt)) / 86400000);
}

// Codes that rarely need the shop: chatter from body, cab and dash computers.
// Engine, aftertreatment, brake and air-system codes always count, even when
// Samsara can only call them "Manufacturer Assignable SPN".
const MINOR_SOURCES = /body controller|climate control|instrument cluster|off vehicle gateway|forward road image|on-board diagnostic unit|cab controller|chassis controller/i;
export const isMinorCode = (c) => MINOR_SOURCES.test(c.source ?? '');

// A code in words: "Engine Exhaust 1 NOx 1 – Data Drifted Low (Engine #2)".
// Manufacturer codes have no description, so the reporting computer and number stand in.
export function codeText(c) {
  const what = /manufacturer assignable/i.test(c.spnText ?? '') || !c.spnText ? `${c.source || 'Code'} ${c.spn}` : c.spnText;
  return [what, c.fmiText].filter(Boolean).join(' – ') + (c.source && !what.startsWith(c.source) ? ` (${c.source})` : '');
}

/**
 * A truck's fault summary for the screens.
 * @param faults  vehicles doc `faults` ({ time, lamps: { stop, warning, emissions, protect }, codes: [...] })
 * @returns { lamps: ['stop'|'warning'|'emissions'|'protect'], major: [codes], minor: [codes], stop: boolean, time } or null
 */
export function faultSummary(faults) {
  if (!faults) return null;
  const lamps = ['stop', 'warning', 'emissions', 'protect'].filter((k) => faults.lamps?.[k]);
  const codes = faults.codes ?? [];
  const major = codes.filter((c) => !isMinorCode(c));
  const minor = codes.filter(isMinorCode);
  if (!lamps.length && !codes.length) return null;
  return { lamps, major, minor, stop: lamps.includes('stop'), time: faults.time ?? null };
}

// "SPN 3226 FMI 18" style id for a code.
export const codeId = (c) => `SPN ${c.spn} FMI ${c.fmi}`;
