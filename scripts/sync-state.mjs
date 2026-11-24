// Keeps the Samsara sync's Firestore writes to what changed, so it can run
// every 12 minutes inside Firestore's free daily quota. The sync remembers a
// short fingerprint of every document it wrote (meta/syncState.hashes) and
// the documents it already deleted (gone); a write whose fields match its
// last fingerprint, or a delete of a document already gone, is skipped.

import { createHash } from 'node:crypto';

// "projects/…/documents/vehicles/123" -> "vehicles/123"
const pathOf = (w) => String(w.delete ?? w.update.name).split('/documents/')[1];
// The fields written (and which ones, for a merge), not the server timestamps.
const fingerprint = (w) => createHash('sha1').update(JSON.stringify([w.update.fields, w.updateMask ?? null])).digest('base64url').slice(0, 12);

/**
 * @param writes   Firestore REST writes (setWrite, mergeWrite, deleteWrite)
 * @param state    the last meta/syncState: { hashes: { path: fingerprint }, gone: [path] }
 * @param always   paths written every run regardless (meta/sync: "Updated X ago")
 * @returns { writes: the ones to send, skipped, state: the new { hashes, gone } }
 */
export function onlyChanged(writes, state = {}, { always = [] } = {}) {
  const hashes = { ...(state.hashes ?? {}) };
  const gone = new Set(state.gone ?? []);
  const out = [];
  let skipped = 0;
  for (const w of writes) {
    const path = pathOf(w);
    if (w.delete) {
      if (gone.has(path)) { skipped += 1; continue; }
      gone.add(path);
      delete hashes[path];
      out.push(w);
      continue;
    }
    const h = fingerprint(w);
    if (!always.includes(path) && hashes[path] === h) { skipped += 1; continue; }
    hashes[path] = h;
    gone.delete(path);
    out.push(w);
  }
  return { writes: out, skipped, state: { hashes, gone: [...gone] } };
}

// Duty cycles come from 90 days of Samsara data: classifying every 6 hours is plenty.
export const DUTY_EVERY_MS = 6 * 60 * 60 * 1000;
export const dutyDue = (state = {}, now = Date.now()) => !state.dutyAt || now - Date.parse(state.dutyAt) >= DUTY_EVERY_MS;

// A truck's schedules, as remembered: baselines are only looked for when a
// truck is new or its schedules changed.
export const scheduleSignature = (v) => `${v.id}:${[...(v.scheduleIds ?? [])].sort().join('+')}`;
