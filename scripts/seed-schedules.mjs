// Writes data/maintenance-schedules.json to the Firestore
// `maintenanceSchedules` collection. No Samsara key needed. The sync job also
// does this on every run; use this to push schedule edits right away.
//
// Usage: node scripts/seed-schedules.mjs [--dry-run]

import { commit, setWrite } from './firestore-rest.mjs';
import { scheduleDocs, validate } from './schedules.mjs';

validate();
const docs = scheduleDocs();
for (const d of docs) {
  console.log(`${d.category.padEnd(10)} ${d.id.padEnd(38)} ${d.items.length} items`);
}
if (process.argv.includes('--dry-run')) process.exit(0);

await commit(docs.map((d) => setWrite(`maintenanceSchedules/${d.id}`, d)));
console.log(`Wrote ${docs.length} schedules to Firestore`);
