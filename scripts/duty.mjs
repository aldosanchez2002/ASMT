// Classifies each truck's duty cycle from its recent Samsara numbers using
// each manufacturer's rules, with a stability window so a truck only
// switches after the new classification has held for a while.

export const WINDOW_DAYS = 90;
export const STABLE_DAYS = 14;
// Trucks with fewer total engine hours keep the default (normal OTR) schedule.
export const MIN_ENGINE_HOURS = 500;
// MPG is only trusted when the window has at least this many miles.
const MIN_MILES_FOR_MPG = 1000;

/** Metrics from a Samsara fuel-energy report row over WINDOW_DAYS. */
export function metricsFromReport(report, windowDays = WINDOW_DAYS) {
  const miles = report.distanceTraveledMeters / 1609.344;
  const gallons = report.fuelConsumedMl / 3785.41;
  const run = report.engineRunTimeDurationMs;
  return {
    windowDays,
    miles: Math.round(miles),
    annualMiles: Math.round((miles * 365) / windowDays),
    // Overall MPG including idle fuel, which is what Detroit and Cummins use.
    mpg: gallons > 0 && miles >= MIN_MILES_FOR_MPG ? Math.round((miles / gallons) * 100) / 100 : null,
    idlePct: run > 0 ? Math.round((1000 * report.engineIdleTimeDurationMs) / run) / 10 : null,
    engineHoursInWindow: Math.round(run / 3.6e6),
  };
}

const CUMMINS_STEPS = ['light', 'normal', 'shortHaul', 'severe'];

const RULES = {
  // Detroit DD Platform operator's manual / DDC-SVC-BRO-0001 service applications.
  detroit(m) {
    const mpg = m.mpg;
    if (m.annualMiles < 30000 || (mpg != null && mpg < 5.0)) return 'severe';
    if (m.annualMiles < 60000 || (mpg != null && mpg < 6.0)) return 'shortHaul';
    if (mpg != null && mpg >= 7.0 && m.idlePct != null && m.idlePct < 20) return 'efficientLongHaul';
    return 'longHaul';
  },
  // Cummins X15 2020+ quick reference guides: MPG bands, then idle + PTO > 40%
  // drops Light, Normal and Short Haul one level. (PTO time isn't available.)
  cummins(m) {
    if (m.mpg == null) return null;
    let i = m.mpg < 5 ? 3 : m.mpg < 6 ? 2 : m.mpg < 7 ? 1 : 0;
    if (m.idlePct != null && m.idlePct > 40 && i < 3) i += 1;
    return CUMMINS_STEPS[i];
  },
  // Cummins X15 EPA 2017 quick reference guide.
  cummins2017(m) {
    if (m.mpg == null) return null;
    if (m.mpg < 5.5) return 'severe';
    return m.mpg <= 6.5 ? 'normal' : 'light';
  },
  // Freightliner maintenance manual service schedules.
  freightliner(m) {
    return m.annualMiles < 60000 ? 'schedule1' : 'schedule2';
  },
};

/**
 * The duty cycle each model's rules give for these metrics, or null when
 * there isn't enough data (the default schedule is used then).
 * @param model     duty model id ('detroit', 'cummins', ...)
 * @param metrics   metricsFromReport() result, or null if Samsara had no report
 * @param totalEngineHours  the truck's lifetime engine hours
 */
export function classify(model, metrics, totalEngineHours) {
  if (!RULES[model]) return null;
  if (totalEngineHours == null || totalEngineHours < MIN_ENGINE_HOURS) return null;
  if (!metrics) return null;
  return RULES[model](metrics);
}

/**
 * Applies the stability window. `state` is the stored { current, pending,
 * pendingSince } for one model; returns the new state and whether `current`
 * changed. The first classification applies immediately.
 */
export function nextState(state = {}, candidate, now = new Date()) {
  const { current = null, pending = null, pendingSince = null } = state;
  if (candidate == null) return { state: { current, pending: null, pendingSince: null }, changed: false };
  if (current == null || candidate === current) {
    return { state: { current: candidate, pending: null, pendingSince: null }, changed: false, initial: current == null };
  }
  if (pending === candidate && pendingSince) {
    const heldDays = (now - new Date(pendingSince)) / 86400000;
    if (heldDays >= STABLE_DAYS) {
      return { state: { current: candidate, pending: null, pendingSince: null }, changed: true, from: current };
    }
    return { state: { current, pending, pendingSince }, changed: false };
  }
  return { state: { current, pending: candidate, pendingSince: now.toISOString() }, changed: false };
}
