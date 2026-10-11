// Trailer miles from Samsara GPS. Trailers have no hubodometers and most
// trackers report no odometer, so each sync adds up the distance between a
// trailer's GPS points since the last run. Kept in trailerMiles/{trailerId}
// (the trailers docs are rewritten every sync):
//   { miles, startedAt, last: { lat, lon, time }, days: { "YYYY-MM-DD": miles at end of day } }

import { distanceM } from '../web/signals.js';

const METERS_PER_MILE = 1609.344;
// GPS drifts a little while parked; shorter hops than this don't count.
export const MIN_HOP_M = 100;
const KEEP_DAYS = 400;

/**
 * Adds GPS points to a trailer's running miles.
 * @param state   previous trailerMiles doc, or null for a new trailer
 * @param points  [{ lat, lon, time }] in any order
 * @param now     Date, for a new trailer's start
 * @returns the updated doc (a new object)
 */
export function addGpsMiles(state, points, now = new Date()) {
  const next = {
    miles: state?.miles ?? 0,
    startedAt: state?.startedAt ?? now.toISOString(),
    last: state?.last ?? null,
    days: { ...(state?.days ?? {}) },
  };
  const sorted = points
    .filter((p) => p?.lat != null && p?.lon != null && p.time)
    .sort((a, b) => a.time.localeCompare(b.time));
  for (const p of sorted) {
    if (next.last && p.time <= next.last.time) continue;
    if (next.last) {
      const hop = distanceM(next.last, p);
      if (hop >= MIN_HOP_M) next.miles = Math.round((next.miles + hop / METERS_PER_MILE) * 10) / 10;
      else continue; // parked: keep the first point of the stop, so slow drift can't add up
    }
    next.last = { lat: p.lat, lon: p.lon, time: p.time };
    next.days[p.time.slice(0, 10)] = next.miles;
  }
  // Keep about a year of daily readings.
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  for (const day of Object.keys(next.days)) if (day < cutoff) delete next.days[day];
  return next;
}

// Samsara's trailer GPS history -> { trailerId: [{ lat, lon, time }] }.
export function pointsByTrailer(history) {
  const out = {};
  for (const t of history) {
    out[t.id] = (t.gps ?? []).map((g) => ({ lat: g.latitude, lon: g.longitude, time: g.time }));
  }
  return out;
}
