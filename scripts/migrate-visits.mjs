// One-time move to the visit model: the service log becomes the only record
// of what was done, and "last done" is worked out from it (lastDoneFrom in
// web/maintenance.js). serviceRecords keeps only the launch-day tracking starts.
//
// It first proves nothing changes: every truck's due dates are worked out the
// old way (serviceRecords) and the new way (visits) and must match exactly.
//
// Usage:
//   node scripts/migrate-visits.mjs                        # dry run: compare, write nothing
//   node scripts/migrate-visits.mjs --apply                # add `services` to every log entry (safe while the old app is live)
//   node scripts/migrate-visits.mjs --remove-done-records --baselines-from <work-log backup.json>
//                                                          # after the new app is live: put back the tracking
//                                                          # starts the old "done" lines replaced
//   node scripts/migrate-visits.mjs --undo <backup.json>
// Backups are written to the folder given by --backup-dir (default: current folder).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, docsPath, listDocs, mergeWrite } from './firestore-rest.mjs';
import {
  effectiveSettings, lastDoneFrom, truckMaintenance, visitServices,
} from '../web/maintenance.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const fieldPath = (key) => `items.\`${key}\``;
const deleteFields = (path, fieldPaths) => ({
  update: { name: `${docsPath}/${path}`, fields: {} },
  updateMask: { fieldPaths },
});

async function undo(file) {
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  const writes = [];
  for (const [id, before] of Object.entries(backup.serviceLog ?? {})) {
    // Put back the fields this run changed; `null` means it wasn't there.
    const set = Object.fromEntries(Object.entries(before).filter(([, v]) => v !== null));
    const unset = Object.keys(before).filter((k) => before[k] === null);
    if (Object.keys(set).length) writes.push(mergeWrite(`serviceLog/${id}`, set));
    if (unset.length) writes.push(deleteFields(`serviceLog/${id}`, unset));
  }
  for (const [vehicleId, items] of Object.entries(backup.serviceRecords ?? {})) {
    writes.push(mergeWrite(`serviceRecords/${vehicleId}`, Object.fromEntries(
      Object.entries(items).map(([key, rec]) => [fieldPath(key), rec]),
    )));
  }
  await commit(writes);
  console.log(`Undone: ${writes.length} write(s) from ${file}`);
}

const [vehicles, records, serviceLog, scheduleDocs, meta, dutyDocs] = await Promise.all([
  listDocs('vehicles'), listDocs('serviceRecords'), listDocs('serviceLog'),
  listDocs('maintenanceSchedules'), listDocs('meta'), listDocs('dutyCycles'),
]);

if (flag('--undo')) {
  await undo(opt('--undo'));
  process.exit(0);
}

// 1. Every log entry gets `services` (from `itemKeys` or `scheduleId`/`itemId`).
const visits = Object.entries(serviceLog).map(([id, e]) => ({ ...e, id, services: visitServices(e) }));
const toUpdate = Object.entries(serviceLog).filter(([, e]) => !Array.isArray(e.services) && e.type !== 'duty');

// 2. Compare every truck's due dates, old way vs new way.
const schedules = new Map(Object.entries(scheduleDocs));
const settings = effectiveSettings(meta.schedules?.settings, meta.settings);
const dutyModels = meta.schedules?.dutyModels ?? {};
const now = new Date();
const byTruck = Map.groupBy(visits, (v) => v.vehicleId);
const DUE_FIELDS = ['status', 'dueMiles', 'dueHours', 'dueDate'];
const LAST_FIELDS = ['miles', 'hours', 'date', 'source'];
const differences = [];
let compared = 0;
for (const v of Object.values(vehicles)) {
  const oldLast = records[v.id]?.items ?? {};
  const newLast = lastDoneFrom(byTruck.get(v.id) ?? [], oldLast);
  const oldRows = truckMaintenance(v, schedules, oldLast, now, settings, dutyModels, dutyDocs[v.id]);
  const newRows = truckMaintenance(v, schedules, newLast, now, settings, dutyModels, dutyDocs[v.id]);
  for (const o of oldRows) {
    const n = newRows.find((r) => r.key === o.key);
    compared += 1;
    for (const f of DUE_FIELDS) {
      if (o[f] !== n?.[f]) differences.push(`${v.name} ${o.item.name}: ${f} ${o[f]} → ${n?.[f]}`);
    }
    for (const f of LAST_FIELDS) {
      if ((o.last?.[f] ?? null) !== (n?.last?.[f] ?? null)) {
        differences.push(`${v.name} ${o.item.name}: last ${f} ${o.last?.[f]} → ${n?.last?.[f]}`);
      }
    }
  }
}
const doneLines = Object.entries(records).flatMap(([vehicleId, r]) => Object.entries(r.items ?? {})
  .filter(([, rec]) => rec?.source === 'done').map(([key, rec]) => ({ vehicleId, key, rec })));

console.log(`Trucks: ${Object.keys(vehicles).length} · items compared: ${compared}`);
console.log(`Log entries: ${visits.length} (${toUpdate.length} need a "services" field)`);
console.log(`Old "done" lines in serviceRecords: ${doneLines.length}`);
console.log(`Differences between old and new due dates: ${differences.length}`);
for (const d of differences) console.log(`  ${d}`);

if (differences.length) {
  console.log('\nNot safe: fix the differences first. Nothing was written.');
  process.exit(1);
}
const apply = flag('--apply');
const removeDone = flag('--remove-done-records');
if (!apply && !removeDone) {
  console.log('\nDry run: nothing was written.');
  process.exit(0);
}

const backup = { createdAt: now.toISOString(), serviceLog: {}, serviceRecords: {} };
const writes = [];
if (apply) {
  for (const [id, e] of toUpdate) {
    backup.serviceLog[id] = { services: null, ...(e.itemKeys ? { itemKeys: e.itemKeys } : {}) };
    writes.push(mergeWrite(`serviceLog/${id}`, { services: visitServices(e) }));
    if (e.itemKeys) writes.push(deleteFields(`serviceLog/${id}`, ['itemKeys']));
  }
}
if (removeDone) {
  // Each old "done" line replaced a launch-day tracking start; put that back so
  // deleting a visit later falls back to it. Lines with no known start are removed.
  const source = opt('--baselines-from');
  const original = source ? JSON.parse(readFileSync(source, 'utf8')).records ?? {} : {};
  let restored = 0;
  for (const [vehicleId, lines] of Map.groupBy(doneLines, (l) => l.vehicleId)) {
    backup.serviceRecords[vehicleId] = Object.fromEntries(lines.map((l) => [l.key, l.rec]));
    const starts = lines.filter((l) => original[vehicleId]?.[l.key]?.source === 'baseline');
    const others = lines.filter((l) => !starts.includes(l));
    if (starts.length) {
      writes.push(mergeWrite(`serviceRecords/${vehicleId}`, Object.fromEntries(
        starts.map((l) => [fieldPath(l.key), original[vehicleId][l.key]]),
      )));
      restored += starts.length;
    }
    if (others.length) writes.push(deleteFields(`serviceRecords/${vehicleId}`, others.map((l) => fieldPath(l.key))));
  }
  console.log(`Tracking starts put back: ${restored} of ${doneLines.length}`);
}
const backupFile = join(opt('--backup-dir') ?? '.', `migrate-visits.backup-${now.toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(backupFile, `${JSON.stringify(backup, null, 2)}\n`);
await commit(writes);
console.log(`\nBackup: ${backupFile}\nWrote ${writes.length} change(s). To undo: node scripts/migrate-visits.mjs --undo ${backupFile}`);
