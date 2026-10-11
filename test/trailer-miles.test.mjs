import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addGpsMiles } from '../scripts/trailer-miles.mjs';

const now = new Date('2026-10-11T12:00:00Z');
// About 1 mile of latitude is 0.01447 degrees.
const p = (lat, time, lon = -106.236) => ({ lat, lon, time });

test('a new trailer starts at zero from its first point', () => {
  const s = addGpsMiles(null, [p(31.75, '2026-10-11T10:00:00Z')], now);
  assert.equal(s.miles, 0);
  assert.equal(s.startedAt, now.toISOString());
  assert.equal(s.last.time, '2026-10-11T10:00:00Z');
});

test('driving adds up; parked drift does not', () => {
  let s = addGpsMiles(null, [p(31.75, '2026-10-11T10:00:00Z')], now);
  s = addGpsMiles(s, [
    p(31.75002, '2026-10-11T10:05:00Z'), // 2 m drift
    p(31.75001, '2026-10-11T10:10:00Z'),
    p(31.76447, '2026-10-11T10:30:00Z'), // ~1 mile
    p(31.77894, '2026-10-11T10:50:00Z'), // ~1 more
  ], now);
  assert.ok(s.miles > 1.9 && s.miles < 2.1, String(s.miles));
  assert.equal(s.days['2026-10-11'], s.miles);
});

test('points already counted are skipped, so re-runs never double count', () => {
  const pts = [p(31.75, '2026-10-11T10:00:00Z'), p(31.76447, '2026-10-11T10:30:00Z')];
  const once = addGpsMiles(null, pts, now);
  const twice = addGpsMiles(once, pts, now);
  assert.equal(twice.miles, once.miles);
});

test('end-of-day readings per day', () => {
  const s = addGpsMiles(null, [
    p(31.75, '2026-10-10T20:00:00Z'), p(31.76447, '2026-10-10T21:00:00Z'), p(31.77894, '2026-10-11T08:00:00Z'),
  ], now);
  assert.ok(s.days['2026-10-10'] > 0.9 && s.days['2026-10-10'] < 1.1);
  assert.ok(s.days['2026-10-11'] > 1.9);
});
