// What each kind of shop job counts as done. Shared by the website ("Log work")
// and the scripts (paper work log import), so they can't drift apart.
// Plain ES module, no dependencies.

import { recordKey } from './maintenance.js';

// Service tag -> schedule item ids it covers. Only the items a truck's
// schedules actually have are used (e.g. Freightliner has no air filter item).
export const SERVICE_ITEMS = {
  oil: ['oil'],
  fuelFilters: ['fuel-filter-engine', 'fuel-filter-frame', 'fuel-filter-engine-noframe', 'fuel-filter'],
  chassisPm: ['m1', 'pm-a', 'pm-15k'],
  airFilter: ['air-filter', 'air-cleaner'],
  airDryer: ['air-dryer-coalescing'],
};

// The jobs the shop logs, in the words it uses. Per the shop: a PM is oil,
// filters (not the air filter), grease and levels.
export const JOBS = [
  { id: 'pm', label: 'PM', hint: 'oil, fuel filters, grease, levels', tags: ['oil', 'fuelFilters', 'chassisPm'] },
  { id: 'oilChange', label: 'Oil change', hint: 'oil, fuel filters', tags: ['oil', 'fuelFilters'] },
  { id: 'airFilter', label: 'Air filter', tags: ['airFilter'] },
  { id: 'airDryer', label: 'Air dryer', tags: ['airDryer'] },
];

/**
 * Record keys ({scheduleId}__{itemId}) that service tags cover on a truck.
 * @param vehicle   { scheduleIds }
 * @param tags      e.g. ['oil', 'fuelFilters']
 * @param schedules Map of scheduleId -> schedule ({ items: [{ id }] })
 */
export function itemKeysFor(vehicle, tags, schedules) {
  const keys = [];
  for (const scheduleId of vehicle.scheduleIds ?? []) {
    const schedule = schedules.get(scheduleId);
    for (const tag of tags ?? []) {
      for (const itemId of SERVICE_ITEMS[tag] ?? []) {
        const key = recordKey(scheduleId, itemId);
        if (schedule?.items.some((i) => i.id === itemId) && !keys.includes(key)) keys.push(key);
      }
    }
  }
  return keys;
}
