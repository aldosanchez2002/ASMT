// Loads a typed-up paper work log into Firestore (see scripts/work-log.mjs
// for the file format and the rules). Dry run by default.
//
// Usage:
//   node scripts/seed-work-log.mjs <work-log.json>           # dry run: prints every change, writes nothing
//   node scripts/seed-work-log.mjs <work-log.json> --apply   # saves a backup next to the file, then writes
//   node scripts/seed-work-log.mjs --undo <backup.json>      # puts everything back the way the backup says
//
// Keep the work log file out of this public repo; it's fleet data.

import { readFileSync, writeFileSync } from 'node:fs';
import { commit, docsPath, listDocs, mergeWrite, setWrite, deleteWrite } from './firestore-rest.mjs';
import { planWorkLog } from './work-log.mjs';
import { effectiveSettings, mostUrgent, truckMaintenance } from '../web/maintenance.js';

const args = process.argv.slice(2);
const fmt = new Intl.NumberFormat('en-US');
const field = (key) => `items.\`${key}\``;

// Deletes one field of a document (in the update mask, absent from the data).
const deleteFieldWrite = (path, fieldPath) => ({
  update: { name: `${docsPath}/${path}`, fields: {} },
  updateMask: { fieldPaths: [fieldPath] },
});

async function undo(backupFile) {
  const backup = JSON.parse(readFileSync(backupFile, 'utf8'));
  const writes = [];
  for (const [vehicleId, items] of Object.entries(backup.records)) {
    for (const [key, before] of Object.entries(items)) {
      writes.push(before
        ? mergeWrite(`serviceRecords/${vehicleId}`, { [field(key)]: before })
        : deleteFieldWrite(`serviceRecords/${vehicleId}`, field(key)));
    }
  }
  for (const [collection, docs] of Object.entries(backup.docs)) {
    for (const [id, before] of Object.entries(docs)) {
      writes.push(before ? setWrite(`${collection}/${id}`, before) : deleteWrite(`${collection}/${id}`));
    }
  }
  await commit(writes);
  console.log(`Undone: ${writes.length} write(s) from ${backupFile}`);
}

const recText = (r) => (r
  ? `${r.source === 'baseline' ? 'tracking start' : 'done'} ${r.date ?? '(no date)'} at ${r.miles == null ? '—' : fmt.format(r.miles)} mi`
  : 'none');

function statusText(rows, key) {
  const r = rows.find((x) => x.key === key);
  if (!r) return '—';
  if (r.milesLeft == null) return r.status;
  return `${r.status} (${r.milesLeft < 0 ? `${fmt.format(-r.milesLeft)} mi over` : `${fmt.format(r.milesLeft)} mi left`})`;
}

async function run(file, apply) {
  const log = JSON.parse(readFileSync(file, 'utf8'));
  const [vehicles, records, status, serviceLog, scheduleDocs, meta, dutyDocs] = await Promise.all([
    listDocs('vehicles'), listDocs('serviceRecords'), listDocs('vehicleStatus'), listDocs('serviceLog'),
    listDocs('maintenanceSchedules'), listDocs('meta'), listDocs('dutyCycles'),
  ]);
  const plan = planWorkLog(log, vehicles, records, status);

  // What each truck looks like before and after, with the live schedules and settings.
  const schedules = new Map(Object.entries(scheduleDocs));
  const settings = effectiveSettings(meta.schedules?.settings, meta.settings);
  const dutyModels = meta.schedules?.dutyModels ?? {};
  const now = new Date();
  const afterRecords = structuredClone(records);
  for (const c of plan.recordChanges) {
    afterRecords[c.vehicleId] ??= { items: {} };
    afterRecords[c.vehicleId].items ??= {};
    afterRecords[c.vehicleId].items[c.key] = c.after;
  }
  const rowsFor = (v, recs) => truckMaintenance(v, schedules, recs[v.id]?.items, now, settings, dutyModels, dutyDocs[v.id]);

  const byTruck = Map.groupBy(plan.recordChanges, (c) => c.vehicleName);
  const names = [...byTruck.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const name of names) {
    const changes = byTruck.get(name);
    const v = vehicles[changes[0].vehicleId];
    const before = rowsFor(v, records);
    const after = rowsFor(v, afterRecords);
    const nextBefore = mostUrgent(before);
    const nextAfter = mostUrgent(after);
    console.log(`\n${name}  (${fmt.format(v.odometerMiles ?? 0)} mi now)` +
      `  next: ${nextBefore ? `${nextBefore.item.name} ${nextBefore.status}` : '—'} → ${nextAfter ? `${nextAfter.item.name} ${nextAfter.status}` : '—'}`);
    console.table(changes.map((c) => ({
      item: after.find((r) => r.key === c.key)?.item.name ?? c.key,
      before: recText(c.before),
      after: recText(c.after),
      'status before': statusText(before, c.key),
      'status after': statusText(after, c.key),
    })));
  }

  const repairs = Object.values(plan.logEntries).filter((e) => e.type === 'repair').length;
  console.log(`\nService log: ${Object.keys(plan.logEntries).length} entries (${repairs} repairs)`);
  console.log(`Service records: ${plan.recordChanges.length} item(s) on ${names.length} truck(s)`);
  console.log(`Local trucks: ${Object.values(plan.localVehicles).map((v) => `${v.name} (${v.odometerMiles == null ? 'no miles' : `${fmt.format(v.odometerMiles)} mi`})`).join(', ') || 'none'}`);
  console.log(`Out of service: ${Object.values(plan.statusDocs).map((s) => `${s.vehicleName} (${s.reason})`).join(', ') || 'none'}`);
  for (const p of plan.problems) console.log(`Note: ${p}`);

  if (!apply) {
    console.log('\nDry run: nothing was written. Add --apply to write.');
    return;
  }

  // Backup of everything this run touches, so --undo can put it back.
  const backup = { createdAt: now.toISOString(), source: file, records: {}, docs: { serviceLog: {}, vehicles: {}, vehicleStatus: {} } };
  for (const c of plan.recordChanges) (backup.records[c.vehicleId] ??= {})[c.key] = c.before;
  for (const id of Object.keys(plan.logEntries)) backup.docs.serviceLog[id] = serviceLog[id] ?? null;
  for (const id of Object.keys(plan.localVehicles)) backup.docs.vehicles[id] = vehicles[id] ?? null;
  for (const id of Object.keys(plan.statusDocs)) backup.docs.vehicleStatus[id] = status[id] ?? null;
  const backupFile = `${file.replace(/\.json$/, '')}.backup-${now.toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(backupFile, `${JSON.stringify(backup, null, 2)}\n`);
  console.log(`\nBackup saved: ${backupFile}`);

  const writes = [
    ...Object.entries(plan.localVehicles).map(([id, v]) => setWrite(`vehicles/${id}`, v, 'updatedAt')),
    ...Object.entries(plan.statusDocs).map(([id, s]) => setWrite(`vehicleStatus/${id}`, s, 'updatedAt')),
    ...Object.entries(plan.logEntries).map(([id, e]) => setWrite(`serviceLog/${id}`, e, 'loggedAt')),
  ];
  for (const [vehicleId, changes] of Map.groupBy(plan.recordChanges, (c) => c.vehicleId)) {
    writes.push(mergeWrite(`serviceRecords/${vehicleId}`, {
      vehicleId,
      ...Object.fromEntries(changes.map((c) => [field(c.key), c.after])),
    }));
  }
  await commit(writes);
  console.log(`Wrote ${writes.length} document(s). To undo: node scripts/seed-work-log.mjs --undo ${backupFile}`);
}

if (args[0] === '--undo' && args[1]) await undo(args[1]);
else if (args[0] && !args[0].startsWith('--')) await run(args[0], args.includes('--apply'));
else {
  console.error('Usage: node scripts/seed-work-log.mjs <work-log.json> [--apply]  |  --undo <backup.json>');
  process.exit(1);
}
