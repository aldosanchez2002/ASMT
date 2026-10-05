import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, metricsFromReport, nextState, STABLE_DAYS } from '../scripts/duty.mjs';

// Numbers from the fleet's 90-day Samsara report (Jul 7 - Oct 5, 2026).
const m = (annualMiles, mpg, idlePct) => ({ annualMiles, mpg, idlePct, miles: Math.round(annualMiles * 90 / 365) });

test('Detroit: long haul, short haul by miles or MPG, severe, efficient long haul', () => {
  assert.equal(classify('detroit', m(101347, 6.89, 43.7), 3183), 'longHaul'); // T-22
  assert.equal(classify('detroit', m(38031, 6.77, 41.2), 34004), 'shortHaul'); // T-01: under 60k mi/yr
  assert.equal(classify('detroit', m(37588, 5.6, 49.9), 40104), 'shortHaul'); // T-07
  assert.equal(classify('detroit', m(80000, 5.5, 30), 5000), 'shortHaul'); // MPG under 6
  assert.equal(classify('detroit', m(2931, null, 37.6), 2450), 'severe'); // truck 100: barely used
  assert.equal(classify('detroit', m(120000, 4.8, 30), 5000), 'severe');
  assert.equal(classify('detroit', m(169373, 7.79, 44.8), 4457), 'longHaul'); // T-41: 7+ MPG but idles a lot
  assert.equal(classify('detroit', m(169373, 7.79, 15), 4457), 'efficientLongHaul');
});

test('Cummins 2020+: MPG bands with the idle over 40% step down', () => {
  assert.equal(classify('cummins', m(104841, 5.68, 56.2), 25000), 'severe'); // T-16: short haul, idle drops to severe
  assert.equal(classify('cummins', m(167608, 7.15, 50.8), 1593), 'normal'); // T-43: light, idle drops to normal
  assert.equal(classify('cummins', m(199108, 8.15, 35.8), 1586), 'light'); // T-44
  assert.equal(classify('cummins', m(120000, 6.5, 30), 5000), 'normal');
  assert.equal(classify('cummins', m(120000, 4.5, 60), 5000), 'severe'); // already severe, no lower step
});

test('Cummins 2017 and Freightliner rules', () => {
  assert.equal(classify('cummins2017', m(157733, 6.42, 49.7), 35160), 'normal'); // T-08
  assert.equal(classify('cummins2017', m(157733, 6.6, 20), 35160), 'light');
  assert.equal(classify('cummins2017', m(157733, 5.4, 20), 35160), 'severe');
  assert.equal(classify('freightliner', m(38031, 6.77, 41), 34004), 'schedule1');
  assert.equal(classify('freightliner', m(101347, 6.89, 43), 3183), 'schedule2');
});

test('new trucks and missing data keep the default (null)', () => {
  assert.equal(classify('detroit', m(28687, 7.12, 45), 229), null); // T-45: under 500 engine hours
  assert.equal(classify('detroit', null, 25000), null); // no Samsara report
  assert.equal(classify('cummins', m(100000, null, 30), 25000), null); // not enough miles for MPG
  assert.equal(classify('unknown-model', m(1, 1, 1), 99999), null);
});

test('metricsFromReport: annualized miles, MPG including idle, idle %', () => {
  const r = metricsFromReport({
    distanceTraveledMeters: 14915864, fuelConsumedMl: 6264895,
    engineRunTimeDurationMs: 1303480789, engineIdleTimeDurationMs: 649812393,
  });
  assert.equal(r.miles, 9268);
  assert.equal(r.annualMiles, 37588);
  assert.equal(r.mpg, 5.6);
  assert.equal(r.idlePct, 49.9);
  assert.equal(metricsFromReport({ distanceTraveledMeters: 1609, fuelConsumedMl: 3785, engineRunTimeDurationMs: 0, engineIdleTimeDurationMs: 0 }).mpg, null);
});

test('stability window: first classification applies, changes wait two weeks', () => {
  const t0 = new Date('2026-10-01T00:00:00Z');
  const day = (n) => new Date(t0.getTime() + n * 86400000);

  let r = nextState({}, 'longHaul', t0);
  assert.deepEqual(r.state, { current: 'longHaul', pending: null, pendingSince: null });
  assert.equal(r.initial, true);

  r = nextState(r.state, 'shortHaul', day(1));
  assert.equal(r.state.current, 'longHaul');
  assert.equal(r.state.pending, 'shortHaul');

  r = nextState(r.state, 'shortHaul', day(1 + STABLE_DAYS - 1));
  assert.equal(r.changed, false);

  r = nextState(r.state, 'shortHaul', day(1 + STABLE_DAYS));
  assert.equal(r.changed, true);
  assert.equal(r.from, 'longHaul');
  assert.deepEqual(r.state, { current: 'shortHaul', pending: null, pendingSince: null });

  // A blip back resets the pending change
  r = nextState(r.state, 'longHaul', day(20));
  r = nextState(r.state, 'shortHaul', day(21));
  assert.equal(r.state.pending, null);
  assert.equal(r.state.current, 'shortHaul');

  // No data keeps the current classification
  r = nextState(r.state, null, day(30));
  assert.equal(r.state.current, 'shortHaul');
});
