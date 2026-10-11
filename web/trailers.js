// Trailer tires: 8 positions on a tandem-axle trailer with duals, tracked by
// position. A tire's miles are the trailer's GPS miles since the last record
// that changed it, or since tracking began. Plain ES module.

// Axle 1 is the front axle of the tandem; Left is the driver side.
export const TIRE_POSITIONS = ['1LO', '1LI', '1RI', '1RO', '2LO', '2LI', '2RI', '2RO'];

const LABELS = {
  en: { axle: 'Axle', L: 'left', R: 'right', O: 'outer', I: 'inner' },
  es: { axle: 'Eje', L: 'izquierda', R: 'derecha', O: 'exterior', I: 'interior' },
};

// "1LO" -> "Axle 1 left outer" / "Eje 1 izquierda exterior".
export function positionName(pos, lang = 'en') {
  const l = LABELS[lang] ?? LABELS.en;
  return `${l.axle} ${pos[0]} ${l[pos[1]]} ${l[pos[2]]}`;
}

// Trailer miles on a date: the last daily reading on or before it (0 before tracking began).
export function milesOn(milesDoc, day, today = new Date().toISOString().slice(0, 10)) {
  if (!milesDoc) return 0;
  if (!day || day >= today) return milesDoc.miles ?? 0;
  const days = Object.keys(milesDoc.days ?? {}).filter((d) => d <= day).sort();
  return days.length ? milesDoc.days[days.at(-1)] : 0;
}

/**
 * Where each tire position stands.
 * @param entries   the trailer's service log entries (tire changes have `tires: ['1LO', ...]`)
 * @param milesDoc  trailerMiles doc ({ miles, startedAt })
 * @returns { [pos]: { miles, since, recorded, entry } }
 *   recorded: false when no change is on record (counting from tracking start)
 */
export function tireStatus(entries = [], milesDoc = null) {
  const current = milesDoc?.miles ?? 0;
  const out = {};
  for (const pos of TIRE_POSITIONS) {
    const last = entries
      .filter((e) => Array.isArray(e.tires) && e.tires.includes(pos))
      .sort((a, b) => (b.miles ?? 0) - (a.miles ?? 0) || (b.date ?? '').localeCompare(a.date ?? ''))[0];
    out[pos] = last
      ? { miles: Math.max(0, Math.round(current - (last.miles ?? 0))), since: last.date ?? null, recorded: true, entry: last }
      : { miles: Math.round(current), since: milesDoc?.startedAt?.slice(0, 10) ?? null, recorded: false, entry: null };
  }
  return out;
}
