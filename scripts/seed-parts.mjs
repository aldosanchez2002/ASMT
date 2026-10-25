// Starter stock list and service kits for the Parts page, from the engine
// makers' filter specs (Detroit DD13/DD15, Cummins X15). Adds only parts and
// kits that aren't in Firestore yet, so edits made in the app are kept.
//
// Sources:
//   Donaldson F111419 (Detroit DD13/15/16 liquid filters), Detroit 13TS-5 and
//   general specifications (EPA10/GHG14 oil capacity), DD15 Gen 5 spec sheet,
//   Cummins X15 quick references 0032808 (EPA2017), 0064269 (2020) and
//   0077777 (EPA2024), Cummins suction fuel filter bulletin.
// Not set on purpose (check on the truck): the 2012 DD13 fuel filters (3-filter
// kit A0000904251 or the later 2-filter A4720900451), the X15 2020/2024
// suction filter (depends on the PACCAR housing), air filters, tire sizes.
//
// Usage: node scripts/seed-parts.mjs [--apply]   (without --apply: dry run)

import { commit, listDocs, mergeWrite, setWrite } from './firestore-rest.mjs';

export const STARTER_PARTS = [
  { id: 'engine-oil', name: 'Engine oil', group: 'oil', unit: 'gal', packs: [{ name: 'Drum', size: 55 }] },
  { id: 'oil-filter-a4721800109', name: 'Oil filter · DD15 2016–20, DD13', number: 'A4721800109 · LF17511 · P551005', group: 'filter', unit: 'each' },
  { id: 'oil-filter-a4711800209', name: 'Oil filter · DD15 Gen 5 (2021+)', number: 'A4711800209 · LF17800 · P582506', group: 'filter', unit: 'each' },
  { id: 'fuel-kit-a4720900451', name: 'Fuel filter kit · DD15 2016–20', number: 'A4720900451 · FK13850NN · P551063', group: 'filter', unit: 'each' },
  { id: 'fuel-kit-a4720921705', name: 'Fuel filter kit · DD15 Gen 5 (2021+)', number: 'A4720921705 · P582831', group: 'filter', unit: 'each' },
  { id: 'oil-filter-lf14000nn', name: 'Oil filter · X15 2017–19', number: 'LF14000NN', group: 'filter', unit: 'each' },
  { id: 'oil-filter-lf14001nn', name: 'Oil filter · X15 2020+', number: 'LF14001NN', group: 'filter', unit: 'each' },
  { id: 'fuel-filter-ff5825nn', name: 'Fuel filter (pressure) · X15', number: 'FF5825NN', group: 'filter', unit: 'each' },
  { id: 'fuel-filter-fs20172', name: 'Fuel filter (suction) · X15 PACCAR', number: 'FS20172 · K37-1029', group: 'filter', unit: 'each' },
  { id: 'tire-steer', name: 'Steer tire', group: 'tire', unit: 'each', autoUse: 'steerTire' },
  { id: 'tire-drive', name: 'Drive tire', group: 'tire', unit: 'each', autoUse: 'driveTire' },
  { id: 'tire-trailer', name: 'Trailer tire', group: 'tire', unit: 'each', autoUse: 'trailerTire' },
  { id: 'battery', name: 'Battery', group: 'battery', unit: 'each', autoUse: 'battery' },
];

// Oil in gallons with the filter change: DD15 45.4 qt (Gen 5: 45 qt),
// DD13 40.1 qt, X15 about 46 qt (depends on the oil pan).
const dd15 = { oil: [{ part: 'engine-oil', qty: 11.4 }, { part: 'oil-filter-a4721800109', qty: 1 }], fuelFilters: [{ part: 'fuel-kit-a4720900451', qty: 1 }] };
const dd15Gen5 = { oil: [{ part: 'engine-oil', qty: 11.3 }, { part: 'oil-filter-a4711800209', qty: 1 }], fuelFilters: [{ part: 'fuel-kit-a4720921705', qty: 1 }] };
const x15 = { oil: [{ part: 'engine-oil', qty: 11.5 }, { part: 'oil-filter-lf14001nn', qty: 1 }], fuelFilters: [{ part: 'fuel-filter-ff5825nn', qty: 1 }] };
export const STARTER_KITS = {
  'detroit-dd15-ghg14-longhaul': dd15,
  'detroit-dd15-ghg17-longhaul': dd15,
  'detroit-dd15-ghg17-longhaul@2021': dd15Gen5,
  'detroit-dd15-gen5-longhaul': dd15Gen5,
  'detroit-dd13-epa10-longhaul': { oil: [{ part: 'engine-oil', qty: 10 }, { part: 'oil-filter-a4721800109', qty: 1 }] },
  'cummins-x15-epa2017-normal': {
    oil: [{ part: 'engine-oil', qty: 11.5 }, { part: 'oil-filter-lf14000nn', qty: 1 }],
    fuelFilters: [{ part: 'fuel-filter-ff5825nn', qty: 1 }, { part: 'fuel-filter-fs20172', qty: 1 }],
  },
  'cummins-x15-2020-normal': x15,
  'cummins-x15-epa2024-normal': x15,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [parts, meta] = await Promise.all([listDocs('parts'), listDocs('meta')]);
  const kits = meta.kits ?? {};
  const newParts = STARTER_PARTS.filter((p) => !parts[p.id]);
  const newKits = Object.entries(STARTER_KITS).flatMap(([key, tags]) => Object.entries(tags)
    .filter(([tag]) => !kits[key]?.[tag]).map(([tag, lines]) => ({ key, tag, lines })));
  newParts.forEach((p) => console.log(`part  ${p.id.padEnd(26)} ${p.name}`));
  newKits.forEach((k) => console.log(`kit   ${`${k.key} · ${k.tag}`.padEnd(48)} ${k.lines.map((l) => `${l.qty} ${l.part}`).join(', ')}`));
  if (!process.argv.includes('--apply')) {
    console.log(`Dry run: ${newParts.length} parts, ${newKits.length} kits to add. Re-run with --apply to write.`);
    process.exit(0);
  }
  await commit([
    ...newParts.map((p) => setWrite(`parts/${p.id}`, { min: null, packs: [], number: '', autoUse: null, ...p }, 'createdAt')),
    // One write for every new kit (a document is written once per commit).
    ...(newKits.length ? [mergeWrite('meta/kits', Object.fromEntries(newKits.map((k) => [`\`${k.key}\`.${k.tag}`, k.lines])))] : []),
  ]);
  console.log(`Added ${newParts.length} parts and ${newKits.length} kits.`);
}
