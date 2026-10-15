// Truck tires: 10 positions on a 6x4 tractor (2 steer singles, two drive
// axles with duals), tracked by position. A tire's miles are the truck's
// odometer miles since the last record that replaced it (flats are replaced
// too, so every tire record is a replacement), or since tracking
// began (the truckTires/{vehicleId} start, written by the sync). Plain ES module.

export const STEER = ['SL', 'SR'];
export const TRUCK_TIRE_POSITIONS = ['SL', 'SR', '1LO', '1LI', '1RI', '1RO', '2LO', '2LI', '2RI', '2RO'];
export const isSteer = (pos) => STEER.includes(pos);

// "Check the tread" defaults; both can be changed in Settings.
export const STEER_MILES_LIMIT = 80000;
export const DRIVE_MILES_LIMIT = 150000;

const LABELS = {
  en: { steer: 'Steer', drive: 'Drive', L: 'left', R: 'right', O: 'outer', I: 'inner' },
  es: { steer: 'Dirección', drive: 'Tracción', L: 'izquierda', R: 'derecha', O: 'exterior', I: 'interior' },
};

// "SL" -> "Steer left"; "1LO" -> "Drive 1 left outer" (and in Spanish).
export function truckPositionName(pos, lang = 'en') {
  const l = LABELS[lang] ?? LABELS.en;
  if (isSteer(pos)) return `${l.steer} ${l[pos[1]]}`;
  return `${l.drive} ${pos[0]} ${l[pos[1]]} ${l[pos[2]]}`;
}

/**
 * Where each tire position stands.
 * @param entries      the truck's service log entries; tire records have `tires: [...]`
 * @param currentMiles the truck's odometer now
 * @param start        truckTires doc ({ startedAt, startMiles }) or null
 * @returns { [pos]: { miles, since, recorded, entry } }; miles is null when
 *   there's neither a replacement on record nor a tracking start
 */
export function truckTireStatus(entries = [], currentMiles = null, start = null) {
  const out = {};
  for (const pos of TRUCK_TIRE_POSITIONS) {
    const last = entries
      .filter((e) => Array.isArray(e.tires) && e.tires.includes(pos) && e.miles != null)
      .sort((a, b) => b.miles - a.miles || (b.date ?? '').localeCompare(a.date ?? ''))[0];
    const from = last ? last.miles : start?.startMiles ?? null;
    out[pos] = {
      miles: from == null || currentMiles == null ? null : Math.max(0, Math.round(currentMiles - from)),
      since: last ? last.date ?? null : start?.startedAt?.slice(0, 10) ?? null,
      recorded: Boolean(last),
      entry: last ?? null,
    };
  }
  return out;
}

// The limit for a position: steer or drive.
export const limitFor = (pos, limits = {}) => (isSteer(pos)
  ? limits.steer ?? STEER_MILES_LIMIT
  : limits.drive ?? DRIVE_MILES_LIMIT);

// Positions at or over their limit, most miles first.
export function truckTiresOverLimit(status, limits = {}) {
  return TRUCK_TIRE_POSITIONS.filter((pos) => status[pos]?.miles != null && status[pos].miles >= limitFor(pos, limits))
    .sort((a, b) => status[b].miles - status[a].miles);
}

// Tracking starts for trucks that don't have one yet: today's odometer.
export function missingTireStarts(vehicles, existing = {}, now = new Date()) {
  const out = {};
  for (const v of vehicles) {
    if (existing[v.id] || v.odometerMiles == null) continue;
    out[v.id] = { vehicleId: v.id, startedAt: now.toISOString(), startMiles: v.odometerMiles };
  }
  return out;
}
