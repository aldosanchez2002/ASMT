// One-time import of the office's inspection and registration sheet into
// `compliance/{unitId}` docs (web/compliance.js), matching each row to a
// trailer by its number. Active trailers that aren't in the app (no GPS
// tracker) are added as hand-entered trailers (`local: true`). Rows for units
// that are out of service or sold and not in the app are skipped. Existing
// compliance docs are left alone (edit those in the app) unless --force.
//
// The sheet holds VINs and plates, so its JSON stays out of this repository.
// Usage: node scripts/import-compliance.mjs <rows.json> [--dry-run] [--force]
//   rows.json: [{ name, plate, vin, inspection, registration, note, status }]
//   (dates as written on the sheet: "2027-03-31", "12/31/2026 OK", …)

import { readFileSync } from 'node:fs';
import { commit, listDocs, setWrite } from './firestore-rest.mjs';
import { parseSheetDate } from '../web/compliance.js';

const newId = () => Array.from({ length: 20 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');

// A sheet row as a compliance doc (without unitId), with the dates that had
// to be fixed listed for a person to check.
export function recordFromRow(row) {
  const inspection = parseSheetDate(row.inspection);
  const registration = parseSheetDate(row.registration);
  const checkDates = [
    inspection.fixed && `Inspection: the sheet says ${inspection.fixed}`,
    registration.fixed && `Registration: the sheet says ${registration.fixed}`,
  ].filter(Boolean);
  return {
    unitType: 'trailer', name: row.name, plate: row.plate ?? '', plateState: registration.state ?? null, vin: row.vin ?? '',
    inspectionExpires: inspection.date, registrationExpires: registration.date, registrationState: registration.state ?? null,
    multiYear: registration.state === 'ME', status: row.status ?? 'active', note: row.note ?? null, checkDates,
  };
}

async function main() {
  const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  if (!file) throw new Error('Usage: node scripts/import-compliance.mjs <rows.json> [--dry-run] [--force]');
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  const [trailers, existing] = await Promise.all([listDocs('trailers'), listDocs('compliance')]);
  const byName = new Map(Object.entries(trailers).map(([id, t]) => [String(t.name).trim(), id]));
  const writes = [];
  const report = { matched: [], added: [], skipped: [], kept: [], check: [] };
  for (const row of rows) {
    const rec = recordFromRow(row);
    let id = byName.get(row.name);
    if (!id) {
      if (rec.status !== 'active') { report.skipped.push(`${row.name} (${rec.status}, not in the app)`); continue; }
      id = newId();
      writes.push(setWrite(`trailers/${id}`, { id, name: row.name, local: true }, 'updatedAt'));
      report.added.push(row.name);
    } else report.matched.push(row.name);
    if (existing[id] && !force) { report.kept.push(row.name); continue; }
    if (rec.checkDates.length) report.check.push(`${row.name}: ${rec.checkDates.join('; ')}`);
    writes.push(setWrite(`compliance/${id}`, { ...rec, unitId: id }, 'updatedAt'));
  }
  const inSheet = new Set(rows.map((r) => r.name));
  const notInSheet = [...byName.keys()].filter((n) => !inSheet.has(n));
  console.log(`Matched ${report.matched.length}, added by hand ${report.added.length} (${report.added.join(', ') || 'none'}).`);
  console.log(`Skipped ${report.skipped.length}: ${report.skipped.join(', ') || 'none'}`);
  if (report.kept.length) console.log(`Already in the app, left as is: ${report.kept.join(', ')}`);
  console.log(`Dates to check (${report.check.length}):\n  ${report.check.join('\n  ') || 'none'}`);
  console.log(`Trailers in the app with no row in the sheet: ${notInSheet.join(', ') || 'none'}`);
  if (dryRun) { console.log(`Dry run: ${writes.length} writes not sent.`); return; }
  for (let i = 0; i < writes.length; i += 400) await commit(writes.slice(i, i + 400));
  console.log(`Saved ${writes.length} writes.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
