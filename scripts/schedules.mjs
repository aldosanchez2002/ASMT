// Loads data/maintenance-schedules.json, checks it for mistakes, and works
// out which schedules apply to a given truck.

import { readFileSync } from 'node:fs';

const data = JSON.parse(
  readFileSync(new URL('../data/maintenance-schedules.json', import.meta.url), 'utf8'),
);

const INTERVAL_FIELDS = ['intervalMiles', 'intervalHours', 'intervalMonths', 'firstDueMiles'];

// Throws with a list of every problem found, so a bad edit fails loudly.
export function validate() {
  const problems = [];
  const ids = new Set();
  for (const s of data.schedules) {
    if (ids.has(s.id)) problems.push(`duplicate schedule id ${s.id}`);
    ids.add(s.id);
    if (!data.sources[s.source]) problems.push(`${s.id}: unknown source "${s.source}"`);
    const itemIds = new Set();
    for (const item of s.items) {
      if (itemIds.has(item.id)) problems.push(`${s.id}: duplicate item id ${item.id}`);
      itemIds.add(item.id);
      const hasInterval = INTERVAL_FIELDS.some((f) => Number.isFinite(item[f]) && item[f] > 0);
      if (!hasInterval && !item.notes) problems.push(`${s.id}/${item.id}: no interval or notes`);
    }
  }
  for (const a of data.assignments) {
    for (const id of a.schedules) {
      if (!ids.has(id)) problems.push(`assignment ${JSON.stringify(a.match)}: unknown schedule "${id}"`);
    }
  }
  if (problems.length) throw new Error(`maintenance-schedules.json:\n  ${problems.join('\n  ')}`);
}

// Schedule docs as stored in Firestore, with the source title/url inlined.
export function scheduleDocs() {
  return data.schedules.map((s) => ({
    ...s,
    dutyCycle: data.dutyCycle,
    sourceTitle: data.sources[s.source].title,
    sourceUrl: data.sources[s.source].url,
  }));
}

// Returns the schedule IDs for a truck, or [] if no rule matches.
// Model matching is "contains", so "NEW CASCADIA 126\" SLEEPERCAB" matches CASCADIA.
export function scheduleIdsFor(vehicle) {
  const make = String(vehicle.make ?? '').toUpperCase();
  const model = String(vehicle.model ?? '').toUpperCase();
  const year = Number(vehicle.year);
  const rule = data.assignments.find(({ match: m }) =>
    make === m.make
    && model.includes(m.model)
    && year >= m.yearMin
    && year <= m.yearMax);
  return rule ? rule.schedules : [];
}

export const schedulesVersion = data.version;
