// Moves trucks from one maintenance schedule to another and carries their
// history along: work log entries and tracking starts are keyed
// "{scheduleId}__{itemId}", so the keys are renamed to the new schedule
// (same item ids) and nothing looks "never done" after the move.
//
// Run it right after the matching change to data/maintenance-schedules.json
// reaches main (the sync assigns schedules from that file). A tracking start
// the sync already wrote for the new schedule is replaced by the truck's old one.
//
// Usage: node scripts/move-schedule.mjs --from <id> --to <id> [--min-year 2022] [--apply]
//   Without --apply it only prints what it would change. With --apply, the
//   documents as they were are saved to a backup file in the system temp dir.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, listDocs, mergeWrite } from './firestore-rest.mjs';
import { scheduleById } from './schedules.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const from = arg('from');
const to = arg('to');
const minYear = Number(arg('min-year') ?? 0);
if (!scheduleById.has(from) || !scheduleById.has(to)) {
  console.error('Usage: node scripts/move-schedule.mjs --from <scheduleId> --to <scheduleId> [--min-year N] [--apply]');
  process.exit(1);
}
const toItems = new Set(scheduleById.get(to).items.map((i) => i.id));
const missing = scheduleById.get(from).items.map((i) => i.id).filter((id) => !toItems.has(id));
if (missing.length) console.warn(`Items with no match in ${to} keep their old keys: ${missing.join(', ')}`);

// "from__oil" -> "to__oil" (only for items the new schedule has).
const renameKey = (key) => {
  const [scheduleId, itemId] = key.split('__');
  return scheduleId === from && toItems.has(itemId) ? `${to}__${itemId}` : key;
};

const [vehicles, log, records] = await Promise.all([listDocs('vehicles'), listDocs('serviceLog'), listDocs('serviceRecords')]);
const moving = Object.values(vehicles).filter((v) => v.scheduleIds?.includes(from) && Number(v.year) >= minYear);
const ids = new Set(moving.map((v) => v.id));
const writes = [];
const backup = { vehicles: {}, serviceLog: {}, serviceRecords: {} };

for (const v of moving) {
  backup.vehicles[v.id] = { scheduleIds: v.scheduleIds };
  writes.push(mergeWrite(`vehicles/${v.id}`, { scheduleIds: v.scheduleIds.map((id) => (id === from ? to : id)) }));
}
let entries = 0;
for (const [id, e] of Object.entries(log)) {
  if (!ids.has(e.vehicleId)) continue;
  const fields = {};
  for (const f of ['services', 'itemKeys']) {
    if (Array.isArray(e[f]) && e[f].some((k) => renameKey(k) !== k)) fields[f] = e[f].map(renameKey);
  }
  if (e.scheduleId === from && toItems.has(e.itemId)) fields.scheduleId = to;
  if (!Object.keys(fields).length) continue;
  backup.serviceLog[id] = Object.fromEntries(Object.keys(fields).map((f) => [f, e[f]]));
  writes.push(mergeWrite(`serviceLog/${id}`, fields));
  entries += 1;
}
let recs = 0;
for (const v of moving) {
  const items = records[v.id]?.items;
  if (!items || !Object.keys(items).some((k) => renameKey(k) !== k)) continue;
  const next = {};
  for (const [k, rec] of Object.entries(items)) if (renameKey(k) === k) next[k] = rec;
  for (const [k, rec] of Object.entries(items)) if (renameKey(k) !== k) next[renameKey(k)] = rec;
  backup.serviceRecords[v.id] = { items };
  writes.push(mergeWrite(`serviceRecords/${v.id}`, { items: next }));
  recs += 1;
}

console.log(`${from} -> ${to}${minYear ? ` (model year ${minYear}+)` : ''}`);
console.log(`Trucks: ${moving.map((v) => `${v.name} (${v.year})`).join(', ') || 'none'}`);
console.log(`Work log entries renamed: ${entries} · tracking records renamed: ${recs}`);
if (!process.argv.includes('--apply')) {
  console.log('Dry run. Re-run with --apply to write.');
  process.exit(0);
}
const file = join(tmpdir(), `move-schedule-backup-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(backup, null, 1));
console.log(`Backup: ${file}`);
await commit(writes);
console.log(`Wrote ${writes.length} documents.`);
