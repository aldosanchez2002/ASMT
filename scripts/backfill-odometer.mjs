// One-time fill of odometerDaily with past daily readings from Samsara, so
// "Log work" can check miles typed for old invoices. Asks Samsara for each
// truck's last reading at the end of each day (one call per day) and keeps it
// only if the truck actually reported that day. The sync adds today's
// reading every run after that.
//
// Usage:
//   SAMSARA_API_KEY=... node scripts/backfill-odometer.mjs [--days 365]           # dry run: prints a summary
//   SAMSARA_API_KEY=... node scripts/backfill-odometer.mjs [--days 365] --apply   # writes

import { commit, listDocs, mergeWrite } from './firestore-rest.mjs';
import { dailyField, readingFromStats, samsaraGetAll } from './samsara.mjs';

const args = process.argv.slice(2);
const days = Number(args.includes('--days') ? args[args.indexOf('--days') + 1] : 365);
const apply = args.includes('--apply');

const vehicles = await listDocs('vehicles');
const ids = new Set(Object.keys(vehicles).filter((id) => !vehicles[id].local));
const byTruck = {}; // vehicleId -> { day: reading }

const dayList = [];
for (let i = days; i >= 1; i -= 1) {
  dayList.push(new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
}

// A few days at a time keeps it quick without hammering the API.
for (let i = 0; i < dayList.length; i += 5) {
  await Promise.all(dayList.slice(i, i + 5).map(async (day) => {
    const stats = await samsaraGetAll('/fleet/vehicles/stats', {
      types: 'obdOdometerMeters,gpsOdometerMeters,obdEngineSeconds',
      time: `${day}T23:59:59Z`,
    });
    for (const s of stats) {
      const reading = readingFromStats(s);
      // Only a reading taken that day; otherwise the truck didn't report.
      if (ids.has(s.id) && reading?.at?.slice(0, 10) === day) (byTruck[s.id] ??= {})[day] = reading;
    }
  }));
  process.stdout.write(`\r${Math.min(i + 5, dayList.length)}/${dayList.length} days`);
}
console.log();

const total = Object.values(byTruck).reduce((n, d) => n + Object.keys(d).length, 0);
console.log(`Trucks: ${Object.keys(byTruck).length} of ${ids.size} · daily readings: ${total} (${dayList[0]} to ${dayList.at(-1)})`);
for (const [id, d] of Object.entries(byTruck).sort((a, b) => String(vehicles[a[0]].name).localeCompare(String(vehicles[b[0]].name), undefined, { numeric: true }))) {
  const keys = Object.keys(d).sort();
  console.log(`  ${vehicles[id].name}: ${keys.length} days, ${d[keys[0]].miles.toLocaleString('en-US')} → ${d[keys.at(-1)].miles.toLocaleString('en-US')} mi`);
}
if (!apply) {
  console.log('Dry run: nothing was written. Add --apply to write.');
  process.exit(0);
}
// Merging by field leaves any reading the sync already wrote for today alone.
await commit(Object.entries(byTruck).map(([id, d]) => mergeWrite(`odometerDaily/${id}`, Object.fromEntries(
  Object.entries(d).map(([day, reading]) => [dailyField(day), reading]),
))));
console.log(`Wrote daily readings for ${Object.keys(byTruck).length} truck(s).`);
