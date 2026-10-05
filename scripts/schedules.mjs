// Loads data/maintenance-schedules.json, checks it for mistakes, and works
// out which schedules apply to a given truck.

import { readFileSync } from 'node:fs';
import { matchesRule, recordKey } from '../web/maintenance.js';

export { recordKey };

const data = JSON.parse(
  readFileSync(new URL('../data/maintenance-schedules.json', import.meta.url), 'utf8'),
);

const INTERVAL_FIELDS = ['intervalMiles', 'intervalHours', 'intervalMonths', 'firstDueMiles'];

function checkWhen(where, when, settingIds, problems) {
  for (const [k, v] of Object.entries(when ?? {})) {
    if (!settingIds.has(k)) problems.push(`${where}: unknown setting "${k}"`);
    if (typeof v !== 'boolean') problems.push(`${where}: setting "${k}" must be true or false`);
  }
}

// Throws with a list of every problem found, so a bad edit fails loudly.
export function validate() {
  const problems = [];
  const ids = new Set();
  const settingIds = new Set((data.settings ?? []).map((s) => s.id));
  for (const s of data.schedules) {
    if (ids.has(s.id)) problems.push(`duplicate schedule id ${s.id}`);
    ids.add(s.id);
    if (!data.sources[s.source]) problems.push(`${s.id}: unknown source "${s.source}"`);
    if (s.dutyModel && !data.dutyModels?.[s.dutyModel]) problems.push(`${s.id}: unknown duty model "${s.dutyModel}"`);
    const itemIds = new Set();
    for (const item of s.items) {
      if (itemIds.has(item.id)) problems.push(`${s.id}: duplicate item id ${item.id}`);
      itemIds.add(item.id);
      const hasInterval = INTERVAL_FIELDS.some((f) => Number.isFinite(item[f]) && item[f] > 0);
      if (!hasInterval && !item.notes) problems.push(`${s.id}/${item.id}: no interval or notes`);
      checkWhen(`${s.id}/${item.id} onlyWhen`, item.onlyWhen, settingIds, problems);
      for (const v of item.variants ?? []) {
        if (!v.when) problems.push(`${s.id}/${item.id}: variant without "when"`);
        checkWhen(`${s.id}/${item.id} variant`, v.when, settingIds, problems);
      }
      const dutyIds = new Set((data.dutyModels?.[s.dutyModel]?.options ?? []).map((o) => o.id));
      for (const duty of Object.keys(item.byDuty ?? {})) {
        if (!dutyIds.has(duty)) problems.push(`${s.id}/${item.id}: unknown duty cycle "${duty}" for model "${s.dutyModel}"`);
      }
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
export function scheduleIdsFor(vehicle) {
  const rule = data.assignments.find(({ match }) => matchesRule(vehicle, match));
  return rule ? rule.schedules : [];
}

// The year/model groups, stored as meta/schedules for the site's Schedules tab.
export function assignmentsDoc() {
  return {
    version: data.version,
    dutyCycle: data.dutyCycle,
    notes: data.notes,
    settings: data.settings ?? [],
    dutyModels: data.dutyModels ?? {},
    assignments: data.assignments,
  };
}

export const schedulesVersion = data.version;
export const dutyModels = data.dutyModels ?? {};
export const scheduleById = new Map(data.schedules.map((s) => [s.id, s]));

// For each truck, the service items that have no record yet, as baseline
// records ("treat as done today at the current miles/hours"). Existing
// records are never touched.
export function missingBaselines(fleet, serviceRecords, today = new Date().toISOString().slice(0, 10)) {
  const byId = new Map(data.schedules.map((s) => [s.id, s]));
  const out = {};
  for (const v of fleet) {
    if (v.odometerMiles == null) continue;
    const existing = serviceRecords[v.id]?.items ?? {};
    for (const scheduleId of v.scheduleIds) {
      for (const item of byId.get(scheduleId)?.items ?? []) {
        const key = recordKey(scheduleId, item.id);
        if (existing[key]) continue;
        (out[v.id] ??= {})[key] = {
          miles: v.odometerMiles,
          hours: v.engineHours ?? null,
          date: today,
          source: 'baseline',
        };
      }
    }
  }
  return out;
}
