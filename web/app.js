import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getFirestore, collection, deleteField, doc, getDoc, onSnapshot, serverTimestamp, setDoc, writeBatch,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { firebaseConfig, requireSignIn } from './firebase-config.js';
import {
  dutyFor, effectiveSettings, lastDoneFrom, matchesRule, milesMismatch, mostUrgent, readingsNear, resolveItems,
  truckMaintenance, visitServices,
} from './maintenance.js';
import { JOBS, itemKeysFor } from './services.js';
import {
  TIRE_POSITIONS, milesOn, positionName, tireStatus, tiresOverLimit, TIRE_MILES_LIMIT,
} from './trailers.js';
import {
  DRIVE_MILES_LIMIT, STEER_MILES_LIMIT, TRUCK_TIRE_POSITIONS, isSteer, limitFor, truckPositionName,
  truckTireStatus, truckTiresOverLimit,
} from './truck-tires.js';
import { itemName } from './item-names.js';
import {
  activeLang, agoText, dateText, getLang, setLang, t, useEnglish,
} from './i18n.js';
import {
  QUIET_DAYS, atShop, codeId, codeText, faultSummary, quietDays,
} from './signals.js';
import { downloadLog, downloadTruckRecord } from './records.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');

let vehicles = [];
let schedules = new Map(); // scheduleId -> maintenanceSchedules doc
let records = {}; // vehicleId -> serviceRecords doc
let assignments = null; // meta/schedules doc: year/model groups
let savedSettings = {}; // meta/settings doc: fleet setup toggles
let dutyDocs = {}; // vehicleId -> dutyCycles doc ({ current, state, metrics, override })
let statusDocs = {}; // vehicleId -> vehicleStatus doc ({ outOfService, reason, since })
const dutyModels = () => assignments?.dutyModels ?? {};
const settings = () => effectiveSettings(assignments?.settings, savedSettings);
const company = () => ({ name: savedSettings.companyName ?? '', usdot: savedSettings.usdot ?? '' });
// Trailer tire miles limit: set in the Settings tab, or the default.
const tireLimit = () => Number(savedSettings.tireMilesLimit) || TIRE_MILES_LIMIT;
// Truck tire limits (steer / drive): set in the Settings tab, or the defaults.
const truckTireLimits = () => ({
  steer: Number(savedSettings.tireMilesSteer) || STEER_MILES_LIMIT,
  drive: Number(savedSettings.tireMilesDrive) || DRIVE_MILES_LIMIT,
});
let serviceLog = []; // serviceLog docs: visits (services and repairs) and duty changes
let visitsByTruck = new Map(); // vehicleId -> that truck's serviceLog entries
let trailers = []; // trailers docs
let trailerMilesById = {}; // trailerId -> trailerMiles doc (GPS miles)
let truckTireStarts = {}; // vehicleId -> truckTires doc (where tire miles start)
let openTrailerId = null; // trailer shown in the detail dialog
let trSortKey = 'lastReportedAt'; // most recently reported first
let trSortDir = -1;
let openTruckId = null; // truck shown in the detail dialog
let lastSyncIso = null; // meta/sync lastRun, for "Updated X ago"
let work = null; // the open "Record work" form ({ vehicleId, jobs, extra, unticked, repair, days })
let truckFilter = 'all'; // Trucks tab status buttons (TRUCK_FILTERS)
let sortKey = 'name';
let sortDir = 1;
let unsubscribers = [];

function show(section) {
  for (const id of ['loading', 'signed-out', 'not-allowed', 'fleet']) $(id).hidden = id !== section;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// "2026-10-05" or an ISO timestamp -> "Oct 5, 2026"
function niceDate(value) {
  if (!value) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// No signal: a truck or trailer that hasn't reported in QUIET_DAYS (3) days,
// one rule everywhere. Local trucks aren't in Samsara, so they never report.
function isQuiet(v) {
  if (v.local) return false;
  return (quietDays(v.lastReportedAt) ?? Infinity) >= QUIET_DAYS;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.max(mins, 0)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const STATUS_RANK = { overdue: 0, soon: 1, ok: 2 };
const STATUS_WORD = { overdue: 'OVERDUE', soon: 'DUE SOON', ok: 'OK' };
const STATUS_LABEL = {
  overdue: 'Overdue', soon: 'Due soon', ok: 'OK', done: 'Done', 'n/a': 'N/A',
  'as-needed': 'As needed', 'no-record': 'Waiting for sync',
};

// Attaches each truck's maintenance rows and its most urgent item.
function withMaintenance(v) {
  // The service log is the source of truth for "last done"; serviceRecords
  // only holds each item's launch-day tracking start.
  const last = lastDoneFrom(visitsByTruck.get(v.id), records[v.id]?.items);
  const rows = truckMaintenance(v, schedules, last, new Date(), settings(), dutyModels(), dutyDocs[v.id]);
  // Out-of-service trucks aren't counted as due until they're back.
  const shop = statusDocs[v.id]?.outOfService ? statusDocs[v.id] : null;
  const next = shop ? undefined : mostUrgent(rows);
  const rank = next ? STATUS_RANK[next.status] : shop ? 4 : 3;
  // From Samsara: dash lamps and fault codes, parked in the yard, device gone quiet.
  // Fault readings older than a week (a truck that stopped reporting) are kept
  // for the popup but don't flag the truck.
  const allFaults = faultSummary(v.faults);
  const stale = allFaults && (quietDays(allFaults.time) ?? Infinity) > FRESH_FAULT_DAYS;
  const faults = stale ? null : allFaults;
  const oldFaults = stale ? allFaults : null;
  const here = !v.local && atShop(v.location);
  const quiet = v.local ? null : quietDays(v.lastReportedAt);
  // Tires: miles on each position, and the ones over their limit.
  const tires = truckTireStatus(visitsByTruck.get(v.id), v.odometerMiles, truckTireStarts[v.id]);
  const wornTires = truckTiresOverLimit(tires, truckTireLimits());
  // Needs service (one rule for the shop list and the admin count): something
  // due, a STOP lamp or check engine light, a tire over its limit, or out of
  // service. An emissions or protect lamp alone shows but doesn't count.
  const needsService = Boolean(rows.some(DUE) || shop || faults?.stop || faults?.lamps?.includes('warning') || wornTires.length);
  return {
    ...v, rows, next, shop, faults, oldFaults, here, quiet, tires, wornTires, needsService, nextRank: rank * 10 + Math.max(-5, Math.min(5, next?.urgency ?? 5)),
  };
}

const FRESH_FAULT_DAYS = 7;

const plural = (n, word) => `${fmt.format(n)} ${word}${Math.abs(n) === 1 ? '' : 's'}`;

// The dimension (miles / hours / days) that runs out first, as short text.
function limitingText(r) {
  const options = [];
  if (r.milesLeft != null) {
    options.push({ ratio: r.milesLeft / (r.item.intervalMiles || r.item.firstDueMiles), n: r.milesLeft, unit: 'mi' });
  }
  if (r.hoursLeft != null) options.push({ ratio: r.hoursLeft / r.item.intervalHours, n: r.hoursLeft, unit: 'h' });
  if (r.daysLeft != null) options.push({ ratio: r.daysLeft / (r.item.intervalMonths * 30.4), n: r.daysLeft, unit: 'day' });
  const o = options.sort((a, b) => a.ratio - b.ratio)[0];
  if (!o) return STATUS_LABEL[r.status];
  const amount = o.unit === 'day' ? plural(Math.abs(o.n), 'day') : `${fmt.format(Math.abs(o.n))} ${o.unit}`;
  return o.n < 0 ? `${amount} overdue` : `in ${amount}`;
}

const CATEGORY_LABEL = { engine: 'Engine', chassis: 'Chassis', regulatory: 'DOT' };

// "ENGINE" / "CHASSIS" / "DOT" tag shown before a schedule's name.
function categoryTag(schedule) {
  return el('span', `cat-tag cat-${schedule.category}`, CATEGORY_LABEL[schedule.category] ?? schedule.category);
}

function dutyLabel(model, duty) {
  return dutyModels()[model]?.options.find((o) => o.id === duty)?.label ?? duty;
}

// Duty models that apply to a truck, from its schedules, engine first.
function truckDutyModels(v) {
  const ids = (v.scheduleIds ?? []).map((id) => schedules.get(id)).filter((s) => s?.dutyModel);
  return [...new Set(ids.map((s) => s.dutyModel))];
}

function intervalText(item) {
  const parts = [];
  if (item.intervalMiles) parts.push(`${fmt.format(item.intervalMiles)} mi`);
  if (item.intervalHours) parts.push(`${fmt.format(item.intervalHours)} h`);
  if (item.intervalMonths) parts.push(plural(item.intervalMonths, 'month'));
  const every = parts.length ? `Every ${parts.join(' / ')}` : '';
  const first = item.firstDueMiles ? `${item.intervalMiles ? 'First' : 'Once'} at ${fmt.format(item.firstDueMiles)} mi` : '';
  return [first, every].filter(Boolean).join(' · ') || 'As needed';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function statusDot(status) {
  return el('span', `dot dot-${status}`);
}

// Natural sort so "T-9" comes before "T-10".
function compare(a, b) {
  const x = a[sortKey];
  const y = b[sortKey];
  if (x == null || x === '') return 1;
  if (y == null || y === '') return -1;
  if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
  return String(x).localeCompare(String(y), undefined, { numeric: true }) * sortDir;
}

// The status buttons above the trucks table: each shows a count and, when
// tapped, shows only those trucks.
const TRUCK_FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  // The same count as the shop view's "N trucks need service".
  { id: 'service', label: 'Needs service', test: (v) => v.needsService },
  { id: 'overdue', label: 'Overdue', test: (v) => v.next?.status === 'overdue' },
  { id: 'soon', label: 'Due soon', test: (v) => v.next?.status === 'soon' },
  { id: 'out', label: 'Out of service', test: (v) => Boolean(v.shop) },
  { id: 'quiet', label: 'No signal 3+ days', test: (v) => v.quiet != null && v.quiet >= QUIET_DAYS },
];

// A row of count buttons under the search box (Trucks and Trailers tabs).
// `optional` filters only show when they have something (or are selected).
function statusFilter(filters, counts, current, onPick, label, optional = []) {
  const shown = filters.filter((f) => !optional.includes(f.id) || counts[f.id] || current === f.id);
  const bar = el('div', 'status-filter');
  bar.style.setProperty('--n', shown.length);
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', label);
  for (const f of shown) {
    const b = el('button', `sf-${f.id}${counts[f.id] ? ' has' : ''}${current === f.id ? ' active' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(current === f.id));
    b.append(el('span', 'sf-n', fmt.format(counts[f.id])), el('span', 'sf-label', f.label));
    b.addEventListener('click', () => onPick(f.id));
    bar.append(b);
  }
  return bar;
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const all = vehicles.map(withMaintenance);
  const searched = all.filter((v) => !q || [v.name, v.make, v.model, v.year, v.vin].join(' ').toLowerCase().includes(q));
  const counts = Object.fromEntries(TRUCK_FILTERS.map((f) => [f.id, searched.filter(f.test).length]));
  const active = TRUCK_FILTERS.find((f) => f.id === truckFilter) ?? TRUCK_FILTERS[0];
  const visible = searched.filter(active.test).sort(compare);
  $('summary').replaceChildren(statusFilter(TRUCK_FILTERS, counts, truckFilter, (id) => { truckFilter = id; render(); }, 'Show trucks', ['out', 'quiet']));

  $('rows').replaceChildren(...visible.map(row));
  $('empty').hidden = visible.length > 0;
  $('rows').closest('.table-wrap').hidden = visible.length === 0;
  $('empty').textContent = !vehicles.length
    ? 'No trucks in the database yet. On GitHub, run Actions → "Sync Samsara to Firestore".'
    : active.id === 'all' ? 'No trucks match.'
      : `No ${active.label.toLowerCase()} trucks${q ? ' match the search' : ''}.`;

  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.dataset.dir = sortDir === 1 ? 'asc' : 'desc';
  }

  if (openTruckId) renderTruck(all.find((v) => v.id === openTruckId));
  if (openTrailerId) renderTrailer();
  renderSchedules();
  renderSetup();
  renderLog();
  renderTrailers();
  renderShop();
}

// ---- Trailers tab --------------------------------------------------------

const isMoving = (c) => (c.speedMph ?? 0) >= 3;

let trailerFilter = 'all'; // Trailers tab count buttons
const TRAILER_FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'work', label: 'Needs service', test: (c) => c.needsWork },
  { id: 'yard', label: 'In yard', test: (c) => !isQuiet(c) && trailerInYard(c) },
  { id: 'moving', label: 'Moving', test: (c) => !isQuiet(c) && isMoving(c) },
  { id: 'quiet', label: 'No signal 3+ days', test: (c) => isQuiet(c) },
];

function renderTrailers() {
  if (currentTab() !== 'trailers') return;
  const q = $('tr-search').value.trim().toLowerCase();
  const worn = new Set(trailerList().filter((x) => x.worn.length).map((x) => x.c.id));
  const searched = trailers
    .map((c) => ({ ...c, miles: trailerMilesById[c.id]?.miles ?? null, needsWork: worn.has(c.id) }))
    .filter((c) => !q || [c.name, c.location, c.trackerModel, c.trackerSerial].join(' ').toLowerCase().includes(q));
  const counts = Object.fromEntries(TRAILER_FILTERS.map((f) => [f.id, searched.filter(f.test).length]));
  const active = TRAILER_FILTERS.find((f) => f.id === trailerFilter) ?? TRAILER_FILTERS[0];
  const visible = searched
    .filter(active.test)
    .sort((a, b) => {
      const x = a[trSortKey];
      const y = b[trSortKey];
      if (x == null || x === '') return 1;
      if (y == null || y === '') return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * trSortDir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * trSortDir;
    });
  $('tr-summary').replaceChildren(statusFilter(TRAILER_FILTERS, counts, trailerFilter, (id) => { trailerFilter = id; renderTrailers(); }, 'Show trailers', ['quiet']));

  $('tr-rows').replaceChildren(...visible.map((c) => {
    const tr = el('tr');
    tr.className = ['clickable', isQuiet(c) && 'quiet'].filter(Boolean).join(' ');
    tr.tabIndex = 0;
    tr.addEventListener('click', () => openTrailer(c.id));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openTrailer(c.id); });
    const loc = el('td', 'wrap-cell');
    if (c.latitude != null && c.longitude != null) {
      const a = el('a', null, c.location || `${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)}`);
      Object.assign(a, {
        href: `https://www.google.com/maps?q=${c.latitude},${c.longitude}`,
        target: '_blank',
        rel: 'noopener',
      });
      a.addEventListener('click', (e) => e.stopPropagation());
      loc.append(a);
    } else {
      loc.textContent = c.location || '—';
    }
    const statusText = isMoving(c) ? `Moving · ${Math.round(c.speedMph)} mph` : 'Parked';
    const status = el('td', 'hide-sm');
    status.append(el('span', `dot ${isMoving(c) ? 'dot-ok' : ''}`), document.createTextNode(statusText));
    // On phones the status column is hidden and shown under the unit name instead.
    const unit = el('td', 'strong', c.name || '—');
    const unitStatus = el('div', 'item-meta show-sm');
    unitStatus.append(el('span', `dot ${isMoving(c) ? 'dot-ok' : ''}`), document.createTextNode(statusText));
    unit.append(unitStatus);
    tr.append(
      unit,
      el('td', 'num', c.miles == null ? '—' : fmt.format(Math.round(c.miles))),
      loc,
      status,
      el('td', 'muted-cell', timeAgo(c.lastReportedAt)),
      el('td', 'muted-cell hide-sm', [c.trackerModel, c.trackerSerial].filter(Boolean).join(' · ') || '—'),
    );
    return tr;
  }));
  $('tr-empty').hidden = visible.length > 0;
  $('tr-rows').closest('.table-wrap').hidden = visible.length === 0;
  $('tr-empty').textContent = trailers.length
    ? (q ? 'No trailers match.' : `No trailers: ${active.label.toLowerCase()}.`)
    : 'No trailers in the database yet. They are added by the next sync.';

  for (const th of document.querySelectorAll('th[data-trsort]')) {
    th.classList.toggle('sorted', th.dataset.trsort === trSortKey);
    th.dataset.dir = trSortDir === 1 ? 'asc' : 'desc';
  }
}

// ---- Service log tab -------------------------------------------------------

const isoDay = (d) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

// Presets fill in the From/To dates; editing either date switches to "Custom range".
function applyLogPeriod() {
  const period = $('log-period').value;
  for (const id of ['log-from', 'log-to']) $(id).closest('.field').hidden = period !== 'custom';
  if (period === 'custom') return;
  $('log-to').value = period === 'all' ? '' : isoDay(new Date());
  $('log-from').value = period === 'all' ? '' : isoDay(new Date(Date.now() - Number(period) * DAY_MS));
}

function renderLogUnits() {
  const select = $('log-unit');
  const chosen = select.value;
  const names = new Map(vehicles.map((v) => [v.id, v.name]));
  for (const e of serviceLog) if (!names.has(e.vehicleId)) names.set(e.vehicleId, e.vehicleName || e.vehicleId);
  const options = [...names].sort((a, b) => String(a[1]).localeCompare(String(b[1]), undefined, { numeric: true }));
  select.replaceChildren(
    Object.assign(el('option', null, 'All units'), { value: '' }),
    ...options.map(([id, name]) => Object.assign(el('option', null, name), { value: id })),
  );
  select.value = names.has(chosen) ? chosen : '';
}

// Log entries matching the Log tab's filters, newest first.
function filteredLog() {
  const from = $('log-from').value;
  const to = $('log-to').value;
  const unit = $('log-unit').value;
  const rows = serviceLog
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to) && (!unit || e.vehicleId === unit))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.loggedAtMs ?? 0) - (a.loggedAtMs ?? 0));
  return { from, to, unit, rows };
}

// Shows "Preparing…" on a button while a PDF is built.
async function withBusy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing PDF…';
  try {
    await fn();
  } catch (err) {
    showAppError(`Could not make the PDF: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function dutyText(v) {
  const models = truckDutyModels(v);
  if (!models.length) return '';
  const model = models[0];
  const d = dutyDocs[v.id] ?? {};
  const duty = d.override?.[model] ?? d.current?.[model] ?? dutyModels()[model]?.default;
  const how = d.override?.[model] ? 'set by hand' : d.current?.[model] ? 'set from Samsara usage' : 'default';
  return `${dutyModels()[model]?.label ?? ''}: ${dutyLabel(model, duty)} (${how})`;
}

function exportTruck(v, btn, from = '', to = '') {
  const entries = serviceLog
    .filter((e) => e.vehicleId === v.id && e.type !== 'duty' && (!from || e.date >= from) && (!to || e.date <= to))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return withBusy(btn, () => downloadTruckRecord({
    vehicle: v,
    rows: v.rows.filter((r) => r.status !== 'n/a'),
    intervalText,
    entries,
    dutyText: v.local && !v.scheduleIds?.length ? 'Local truck (not in Samsara); no schedule assigned yet' : dutyText(v),
    company: company(),
    from,
    to,
  }));
}

function exportLog(btn) {
  const { from, to, unit, rows } = filteredLog();
  const v = unit && vehicles.find((x) => x.id === unit);
  // One truck selected: its full maintenance record for the period.
  if (v) return exportTruck(withMaintenance(v), btn, from, to);
  return withBusy(btn, () => downloadLog({ entries: rows.filter((e) => e.type !== 'duty'), company: company(), from, to }));
}

function renderLog() {
  if (currentTab() !== 'log') return;
  renderLogUnits();
  const { rows, unit } = filteredLog();
  $('log-pdf').textContent = unit && vehicles.some((x) => x.id === unit)
    ? 'Download maintenance record (PDF)'
    : 'Download PDF';

  const services = rows.filter((e) => e.type !== 'duty');
  const dutyChanges = rows.length - services.length;
  // Automatic duty-cycle changes are hidden unless asked for: they'd bury the real work.
  const showAuto = $('log-auto').checked;
  const shown = showAuto ? rows : services;
  const trucks = new Set(services.filter((e) => e.assetType !== 'trailer').map((e) => e.vehicleId)).size;
  const trailerCount = new Set(services.filter((e) => e.assetType === 'trailer').map((e) => e.vehicleId)).size;
  const units = [trucks && plural(trucks, 'truck'), trailerCount && plural(trailerCount, 'trailer')].filter(Boolean).join(' and ');
  $('log-summary').textContent = [
    services.length && `${plural(services.length, 'service')} on ${units}`,
    dutyChanges && `${plural(dutyChanges, 'automatic change')}${showAuto ? '' : ' (hidden)'}`,
  ].filter(Boolean).join(' · ');
  $('log-empty').hidden = shown.length > 0;
  $('log-rows').closest('.table-wrap').hidden = shown.length === 0;
  $('log-empty').textContent = serviceLog.length
    ? 'No services match these filters.'
    : 'No services recorded yet. Open a truck and use "Record work".';

  $('log-rows').replaceChildren(...shown.map((e) => {
    const tr = el('tr');
    const unitCell = el('td', 'strong');
    const link = el('button', 'link-btn', e.vehicleName || e.vehicleId);
    link.type = 'button';
    link.addEventListener('click', () => {
      if (e.assetType === 'trailer') openTrailer(e.vehicleId);
      else if (vehicles.some((v) => v.id === e.vehicleId)) openTruck(e.vehicleId);
    });
    unitCell.append(link);
    const service = el('td', 'wrap-cell', e.itemName || e.itemId);
    if (e.type === 'duty') service.prepend(el('span', 'badge badge-auto', 'Auto'), ' ');
    if (e.type === 'repair') service.prepend(el('span', 'badge badge-repair', 'Repair'), ' ');
    const done = visitServices(e).map(itemNameFor).filter(Boolean);
    if (done.length) service.append(el('div', 'item-meta', `Marked done: ${done.join(', ')}`));
    const extra = [e.loggedBy && `Logged by ${e.loggedBy}`].filter(Boolean);
    if (extra.length) service.append(el('div', 'item-meta', extra.join(' · ')));
    if (e.note) service.append(el('div', 'item-meta show-sm', `"${e.note}"`));
    tr.append(
      el('td', null, e.date ? niceDate(e.date) : 'Not written'),
      unitCell,
      service,
      el('td', e.miles == null ? 'num empty' : 'num', e.miles == null ? '—' : fmt.format(e.miles)),
      el('td', 'num hide-sm', e.hours == null ? '—' : fmt.format(e.hours)),
      el('td', 'wrap-cell muted-cell hide-sm', e.note || ''),
    );
    return tr;
  }));
}

// ---- Schedules tab ---------------------------------------------------------

// The shop view is the main page; the rest is the admin side.
const TABS = ['shop', 'trucks', 'trailers', 'schedules', 'log', 'settings'];

// ---- Popups and the Back button ---------------------------------------------
// Each popup adds a history step, so the phone's Back button closes the top
// popup instead of leaving the page. Closing a popup with its own button (or
// Esc) takes that step back off.
let ignorePop = 0;
let closingFromBack = false;
function showDialog(dlg) {
  if (dlg.open) return;
  dlg.showModal();
  history.pushState({ dialog: dlg.id }, '');
}
for (const id of ['work', 'truck', 'schedule']) {
  $(id).addEventListener('close', () => {
    if (closingFromBack || history.state?.dialog !== id) return;
    ignorePop += 1;
    history.back();
  });
}
addEventListener('popstate', () => {
  if (ignorePop) { ignorePop -= 1; return; }
  const top = ['work', 'truck', 'schedule'].map((id) => $(id)).find((d) => d.open);
  if (!top) return;
  closingFromBack = true;
  top.close();
  closingFromBack = false;
});

// ---- Admin password ----------------------------------------------------------
// Not real security (anyone can read it here): it only keeps the shop view
// from wandering into the admin pages. Each device remembers once it's typed.
const ADMIN_PASSWORD = 'Covington';
const ADMIN_KEY = 'aslog.admin';
function adminUnlocked() {
  try { return localStorage.getItem(ADMIN_KEY) === 'yes'; } catch { return false; }
}
function askAdminPassword() {
  const dlg = $('admin-lock');
  $('admin-lock-title').textContent = t('adminLockTitle');
  $('admin-pass').placeholder = t('adminPassword');
  $('admin-pass-error').hidden = true;
  $('admin-pass-error').textContent = t('adminWrong');
  $('admin-pass-ok').textContent = t('adminOpen');
  $('admin-pass-cancel').textContent = t('cancel');
  $('admin-pass').value = '';
  if (!dlg.open) dlg.showModal();
  $('admin-pass').focus();
}

function currentTab() {
  const tab = location.hash.slice(1);
  if (!TABS.includes(tab)) return 'shop';
  return tab === 'shop' || adminUnlocked() ? tab : 'shop';
}

function showTab() {
  const tab = currentTab();
  for (const x of TABS) $(`${x}-view`).hidden = x !== tab;
  const shop = tab === 'shop';
  useEnglish(!shop);
  document.body.classList.toggle('shop-mode', shop);
  $('admin-nav').hidden = shop;
  // Top right: EN/ES and "Admin" in the shop view; "← Shop" in admin.
  $('lang').hidden = !shop;
  $('admin-link').hidden = !shop;
  $('shop-link').hidden = shop;
  for (const a of document.querySelectorAll('.tabs a')) {
    a.classList.toggle('active', a.dataset.tab === tab);
    a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false');
  }
  // On a phone the tab row scrolls; keep the open tab in view.
  document.querySelector('.tabs a.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const yearRange = (min, max) => (min === max ? `${min}` : `${min}–${max}`);

// Titled by the model years actually in the fleet (falls back to the rule's range).
function groupTitle(match, trucks) {
  const years = trucks.map((v) => Number(v.year)).filter(Boolean);
  const range = years.length
    ? yearRange(Math.min(...years), Math.max(...years))
    : yearRange(match.yearMin, match.yearMax);
  return `${range} ${titleCase(match.make)} ${match.model.length <= 4 ? match.model : titleCase(match.model)}`;
}

function scheduleTable(schedule, duty = null) {
  const wrap = el('div', 'sched-block');
  const head = el('div', 'sched-head');
  const h3 = el('h3');
  h3.append(categoryTag(schedule), el('span', null, schedule.name));
  head.append(h3);
  const link = el('a', 'muted', 'Manual');
  Object.assign(link, { href: schedule.sourceUrl, target: '_blank', rel: 'noopener', title: schedule.sourceTitle });
  head.append(link);
  wrap.append(head);

  const table = el('table', 'sched-table');
  const thead = el('thead');
  const hr = el('tr');
  ['Service', 'Interval', 'Details'].forEach((h) => hr.append(el('th', null, h)));
  thead.append(hr);
  const tbody = el('tbody');
  for (const item of resolveItems(schedule, settings(), duty)) {
    const tr = el('tr');
    const nameCell = el('td', 'strong', item.name);
    if (item.adjusted) nameCell.append(el('span', 'badge', 'Adjusted'));
    tr.append(nameCell, el('td', 'interval-cell', intervalText(item)));
    const details = el('td', 'details-cell');
    if (item.notes) details.append(el('div', 'item-meta', item.notes));
    if (item.tasks?.length) {
      const d = el('details', 'item-tasks');
      d.append(el('summary', null, `${item.tasks.length} tasks`));
      const ul = el('ul');
      item.tasks.forEach((t) => ul.append(el('li', null, t)));
      d.append(ul);
      details.append(d);
    }
    tr.append(details);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const scroll = el('div', 'table-wrap');
  scroll.append(table);
  wrap.append(scroll);
  return wrap;
}

function renderSetup() {
  if (currentTab() !== 'settings') return;
  for (const [id, key] of [['company-name', 'companyName'], ['company-usdot', 'usdot']]) {
    if (document.activeElement !== $(id)) $(id).value = savedSettings[key] ?? '';
  }
  const limits = truckTireLimits();
  for (const [id, value] of [['tire-limit', tireLimit()], ['tire-limit-steer', limits.steer], ['tire-limit-drive', limits.drive]]) {
    if (document.activeElement !== $(id)) $(id).value = value;
  }
  const defs = assignments?.settings ?? [];
  $('fleet-setup').hidden = defs.length === 0;
  const current = settings();

  const save = async (d, value, buttons) => {
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await setDoc(doc(db, 'meta', 'settings'), { [d.id]: value, updatedAt: serverTimestamp() }, { merge: true });
    } catch (err) {
      showAppError(`Could not save the setting: ${err.message}`);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  };

  $('setup-toggles').replaceChildren(...defs.map((d) => {
    const row = el('div', 'setting');
    const title = el('div', 'setting-title', d.question ?? d.label);
    title.append(el('span', 'chip', d.appliesTo));
    const seg = el('div', 'segmented choice');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', d.question ?? d.label);
    const buttons = [true, false].map((value) => {
      const label = d.choices?.[value ? 'on' : 'off'] ?? (value ? 'Yes' : 'No');
      const b = el('button', current[d.id] === value ? 'active' : '', label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(current[d.id] === value));
      return b;
    });
    buttons.forEach((b, i) => b.addEventListener('click', () => {
      const value = i === 0;
      if (current[d.id] === value) return;
      const label = d.choices?.[value ? 'on' : 'off'] ?? (value ? 'Yes' : 'No');
      if (confirm(`Change "${d.question ?? d.label}" to "${label}" for ALL trucks?`)) save(d, value, buttons);
    }));
    seg.append(...buttons);
    row.append(title, seg, el('p', 'muted setting-desc', d.description));
    return row;
  }));
}

let openGroupKey = null; // year/model group shown in the schedule popup
let groupDutyView = {}; // dutyModel -> duty shown in the schedule popup

function scheduleGroups() {
  const groups = assignments.assignments.map((a) => ({
    ...a,
    key: a.schedules.join('|') + JSON.stringify(a.match),
    trucks: vehicles
      .filter((v) => matchesRule(v, a.match))
      .sort((x, y) => String(x.name).localeCompare(String(y.name), undefined, { numeric: true })),
  }));
  // Most trucks first; ties keep their order (oldest model first).
  return groups.sort((a, b) => b.trucks.length - a.trucks.length);
}

function groupEngine(g) {
  return g.schedules.map((id) => schedules.get(id)).find((s) => s?.category === 'engine');
}

function renderSchedules() {
  if (currentTab() !== 'schedules' && !openGroupKey) return;
  const groupsEl = $('sched-groups');
  if (!assignments || !schedules.size) {
    $('sched-intro').textContent = 'Loading schedules…';
    groupsEl.replaceChildren();
    return;
  }
  $('sched-intro').textContent = 'Tap a model to see its schedule.';

  const groups = scheduleGroups();
  groupsEl.replaceChildren(...groups.map((g) => {
    const b = el('button', `group-row${g.trucks.length ? '' : ' group-empty'}`);
    b.type = 'button';
    const main = el('span', 'group-main');
    main.append(el('span', 'group-name', groupTitle(g.match, g.trucks)));
    for (const category of ['engine', 'chassis']) {
      const sched = g.schedules.map((id) => schedules.get(id)).find((s) => s?.category === category);
      if (!sched) continue;
      const line = el('span', 'group-line');
      line.append(categoryTag(sched), el('span', 'muted', sched.name));
      main.append(line);
    }
    b.append(main, el('span', 'chip', g.trucks.length ? plural(g.trucks.length, 'truck') : 'None'), el('span', 'chev', '›'));
    b.addEventListener('click', () => openGroup(g.key));
    return b;
  }));

  if (openGroupKey) renderGroup(groups.find((g) => g.key === openGroupKey));
}

function openGroup(key) {
  openGroupKey = key;
  groupDutyView = {};
  renderSchedules();
  showDialog($('schedule'));
}

function renderGroup(g) {
  if (!g) { $('schedule').close(); return; }
  $('s-title').textContent = groupTitle(g.match, g.trucks);
  $('s-sub').textContent = [
    groupEngine(g)?.name,
    `Applies to ${yearRange(g.match.yearMin, g.match.yearMax)} models`,
    g.notes,
  ].filter(Boolean).join(' · ');

  const body = $('s-body');
  body.replaceChildren();
  const engine = groupEngine(g);
  const engineDuty = (v) => (engine?.dutyModel ? dutyFor(engine, dutyModels(), dutyDocs[v.id]) : null);
  if (g.trucks.length) {
    const chips = el('div', 'truck-chips');
    for (const v of g.trucks) {
      const duty = engineDuty(v);
      const label = [v.name, v.year, duty && dutyLabel(engine.dutyModel, duty)].filter(Boolean).join(' · ');
      const b = el('button', 'chip chip-btn', label);
      b.type = 'button';
      b.addEventListener('click', () => { $('schedule').close(); openTruck(v.id); });
      chips.append(b);
    }
    body.append(chips);
  } else {
    body.append(el('p', 'muted', 'No trucks in the fleet match this group right now.'));
  }
  for (const id of g.schedules) {
    const schedule = schedules.get(id);
    if (!schedule) continue;
    const model = schedule.dutyModel && dutyModels()[schedule.dutyModel];
    if (!model) {
      body.append(scheduleTable(schedule));
      continue;
    }
    // Show the duty cycle most of this group's trucks are on, switchable.
    if (!groupDutyView[schedule.dutyModel]) {
      const counts = {};
      for (const v of g.trucks) {
        const d = dutyFor(schedule, dutyModels(), dutyDocs[v.id]);
        counts[d] = (counts[d] ?? 0) + 1;
      }
      groupDutyView[schedule.dutyModel] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? model.default;
    }
    const shown = groupDutyView[schedule.dutyModel];
    const table = scheduleTable(schedule, shown);
    const seg = el('div', 'segmented');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', model.label);
    for (const o of model.options) {
      const n = g.trucks.filter((v) => dutyFor(schedule, dutyModels(), dutyDocs[v.id]) === o.id).length;
      const b = el('button', o.id === shown ? 'active' : '', n ? `${o.label} · ${n}` : o.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(o.id === shown));
      b.addEventListener('click', () => { groupDutyView[schedule.dutyModel] = o.id; renderSchedules(); });
      seg.append(b);
    }
    // The switcher sits right under the schedule's heading.
    const rule = el('p', 'item-meta seg-rule', model.options.find((o) => o.id === shown)?.rule ?? '');
    table.querySelector('.sched-head').after(seg, rule);
    body.append(table);
  }
  body.append(el('p', 'muted footnote', `Duty cycle: ${assignments.dutyCycle}. ${assignments.notes}`));
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function cell(text, className = '') {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function nextCell(v) {
  const td = el('td', 'next-cell');
  if (v.shop) {
    td.append(el('span', 'badge badge-shop', 'Out of service'), el('span', 'next-when', v.shop.reason || ''));
    return td;
  }
  if (!v.next) {
    td.append(el('span', 'muted-cell', v.scheduleIds?.length ? 'Waiting for sync' : 'No schedule'));
    return td;
  }
  td.append(statusDot(v.next.status), el('span', 'next-name', v.next.item.name), el('span', `next-when when-${v.next.status}`, limitingText(v.next)));
  return td;
}

// A dash lamp's name in the current language (the code name if a label is missing).
const lampName = (lamp) => t('lamp')?.[lamp] ?? lamp;
const SHORT_LAMP = { stop: 'STOP', warning: 'Check eng.', emissions: 'Emissions', protect: 'Protect' };

// Truck number plus small flags from Samsara: lamps, in the yard, no signal.
function nameCell(v) {
  const td = cell(v.name || '—', 'strong nowrap pin');
  const flags = signalBadges(v, { short: true });
  if (flags.length) {
    const div = el('div', 'name-flags');
    div.append(...flags);
    td.append(div);
  }
  return td;
}

// `lampsOnly`: the shop list's section headings already say in yard / no signal.
function signalBadges(v, { short = false, lampsOnly = false } = {}) {
  const out = [];
  for (const lamp of v.faults?.lamps ?? []) {
    // Red for STOP, yellow for check engine, gray for the rest (emissions, protect).
    const kind = lamp === 'stop' ? 'stop' : lamp === 'warning' ? 'lamp' : 'minor';
    const badge = el('span', `sig sig-${kind}`, short ? SHORT_LAMP[lamp] : lampName(lamp));
    badge.title = lampName(lamp);
    out.push(badge);
  }
  if (lampsOnly) return out;
  if (v.here) out.push(el('span', 'sig sig-here', t('atShop')));
  if (v.quiet != null && v.quiet >= QUIET_DAYS && !v.shop) out.push(el('span', 'sig sig-quiet', short ? `No signal ${v.quiet}d` : t('noSignal', v.quiet)));
  return out;
}

// Lamps and the codes that matter, for the truck popup and the Record work form.
function faultsBox(v, { showMinor = true } = {}) {
  const f = v.faults ?? (showMinor ? v.oldFaults : null);
  if (!f) return null;
  const box = el('div', 'faults-box');
  box.append(el('div', 'section-title', t('activeFaults')));
  if (f.lamps.length) {
    const lamps = el('div', 'fault-lamps');
    f.lamps.forEach((l) => lamps.append(el('span', `sig sig-${l === 'stop' ? 'stop' : 'lamp'}`, lampName(l))));
    box.append(lamps);
  }
  const ul = el('ul', 'fault-list');
  f.major.forEach((c) => ul.append(el('li', null, codeText(c))));
  if (f.major.length) box.append(ul);
  if (f.minor.length) {
    if (showMinor) {
      const more = el('details', 'fault-minor');
      more.append(el('summary', null, t('minorCodes', f.minor.length)));
      const ul2 = el('ul', 'fault-list');
      f.minor.forEach((c) => ul2.append(el('li', null, codeText(c))));
      more.append(ul2);
      box.append(more);
    } else {
      box.append(el('p', 'muted', t('minorCodes', f.minor.length)));
    }
  }
  if (f.time) box.append(el('p', 'item-meta', `Samsara · ${agoText(f.time)}`));
  return box;
}

function row(v) {
  const tr = document.createElement('tr');
  tr.className = ['clickable', isQuiet(v) && 'quiet'].filter(Boolean).join(' ');
  tr.tabIndex = 0;
  tr.addEventListener('click', () => openTruck(v.id));
  tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openTruck(v.id); });
  const miles = v.odometerMiles == null ? '—' : fmt.format(v.odometerMiles);
  const milesCell = cell(miles, 'num strong');
  if (v.odometerSource === 'gps') milesCell.title = 'GPS odometer (no ECU reading)';
  tr.append(
    nameCell(v),
    nextCell(v),
    milesCell,
    cell(v.year || '—'),
    cell(titleCase(v.make || '—'), 'nowrap'),
    cell(titleCase(v.model || '—'), 'nowrap'),
    cell(v.engineHours == null ? '—' : fmt.format(v.engineHours), 'num'),
    cell(v.local ? 'Local truck' : timeAgo(v.lastReportedAt), 'muted-cell nowrap'),
  );
  return tr;
}

// ---- Truck detail dialog -------------------------------------------------

function openTruck(id) {
  openTruckId = id;
  render();
  showDialog($('truck'));
}

function dutySection(v, models) {
  const dutyDoc = dutyDocs[v.id] ?? {};
  const section = el('details', 'duty');
  const engineModel = models[0];
  const engineDuty = dutyDoc.override?.[engineModel] ?? dutyDoc.current?.[engineModel] ?? dutyModels()[engineModel]?.default;
  const summary = el('summary', 'duty-summary');
  summary.append(el('span', 'section-title', 'How it\'s used'), el('span', null, dutyLabel(engineModel, engineDuty)));
  section.append(summary);
  const m = dutyDoc.metrics;
  section.append(el('p', 'muted duty-metrics', m
    ? `Last ${m.windowDays} days: ${fmt.format(m.annualMiles)} mi/yr · ${m.mpg ?? '—'} MPG · ${m.idlePct ?? '—'}% idle. Set automatically from Samsara.`
    : 'Not enough Samsara data yet, so the normal OTR schedule is used.'));

  for (const model of models) {
    const def = dutyModels()[model];
    const auto = dutyDoc.current?.[model];
    const override = dutyDoc.override?.[model];
    const effective = override ?? auto ?? def.default;
    const row = el('label', 'duty-row');
    row.append(el('span', 'duty-model', def.label));
    const select = el('select');
    select.append(Object.assign(
      el('option', null, `Auto: ${dutyLabel(model, auto ?? def.default)}${auto ? '' : ' (default)'}`),
      { value: '' },
    ));
    for (const o of def.options) select.append(Object.assign(el('option', null, `Always ${o.label}`), { value: o.id }));
    select.value = override ?? '';
    select.addEventListener('change', async () => {
      const choice = select.value ? dutyLabel(model, select.value) : 'automatic';
      if (!confirm(`Set ${v.name} to "${choice}"? This changes when its services are due.`)) {
        select.value = override ?? '';
        return;
      }
      select.disabled = true;
      try {
        await setDoc(doc(db, 'dutyCycles', v.id), {
          vehicleId: v.id,
          override: { [model]: select.value || deleteField() },
        }, { merge: true });
      } catch (err) {
        showAppError(`Could not save: ${err.message}`);
      } finally {
        select.disabled = false;
      }
    });
    row.append(select);
    section.append(row);

    const st = dutyDoc.state?.[model];
    if (!override && st?.pending && st.pendingSince) {
      const on = new Date(new Date(st.pendingSince).getTime() + 14 * DAY_MS).toLocaleDateString();
      section.append(el('p', 'item-meta', `Switching to ${dutyLabel(model, st.pending)} on ${on} if it holds.`));
    }
    const rule = def.options.find((o) => o.id === effective)?.rule;
    if (rule) section.append(el('p', 'item-meta', `${dutyLabel(model, effective)}: ${rule}`));
  }
  return section;
}

function lastText(last) {
  if (!last) return 'No record yet';
  const what = last.source === 'baseline' ? 'Tracking started' : 'Last done';
  const when = last.date ? niceDate(last.date) : '(date not written)';
  const miles = last.miles != null ? `at ${fmt.format(last.miles)} mi` : '';
  return `${what} ${when} ${miles}`.trim() + (last.note ? ` · "${last.note}"` : '');
}

function dueText(r) {
  const parts = [];
  if (r.dueMiles != null) parts.push(`${fmt.format(r.dueMiles)} mi`);
  if (r.dueHours != null) parts.push(`${fmt.format(r.dueHours)} h`);
  if (r.dueDate) parts.push(niceDate(r.dueDate));
  if (!parts.length) return STATUS_LABEL[r.status];
  return r.status === 'overdue'
    ? `${limitingText(r)} (was due at ${parts.join(' or ')})`
    : `Due ${limitingText(r)} (at ${parts.join(' or ')})`;
}


// "VIN 1FUJ… [Copy VIN]": copies the VIN for parts orders, insurance, etc.
function vinRow(vin) {
  const row = el('div', 'vin-row');
  const btn = el('button', 'btn btn-ghost vin-copy', 'Copy VIN');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(vin);
    } catch {
      // Older browsers / no permission: copy through a hidden text box.
      const box = Object.assign(document.createElement('textarea'), { value: vin });
      box.style.position = 'fixed';
      box.style.opacity = '0';
      document.body.append(box);
      box.select();
      document.execCommand('copy');
      box.remove();
    }
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = 'Copy VIN'; }, 2000);
  });
  row.append(el('span', 'vin-text', `VIN ${vin}`), btn);
  return row;
}

// ---- Out of service ----------------------------------------------------------

async function saveStatus(v, fields) {
  try {
    await setDoc(doc(db, 'vehicleStatus', v.id), {
      vehicleId: v.id, vehicleName: v.name, ...fields, updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    showAppError(`Could not save: ${err.message}`);
  }
}

// Shown at the top of an out-of-service truck, with the way back.
function shopBanner(v) {
  const box = el('div', 'shop-banner');
  box.append(
    el('div', 'shop-title', 'Out of service'),
    el('div', null, [v.shop.reason, v.shop.since && `since ${niceDate(v.shop.since)}`].filter(Boolean).join(' · ')),
    el('div', 'item-meta', 'Not counted as due, and stays listed even if Samsara stops hearing from it.'),
  );
  const btn = el('button', 'btn', 'Back in service');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    if (!confirm(`Put ${v.name} back in service? Its services will count as due again.`)) return;
    btn.disabled = true;
    await saveStatus(v, { outOfService: false, backOn: new Date().toLocaleDateString('en-CA') });
  });
  box.append(btn);
  return box;
}

// Kept at the bottom of the popup so it isn't tapped by mistake.
function shopButton(v) {
  const btn = el('button', 'btn btn-ghost btn-shop', 'Mark out of service');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    const reason = prompt(`Why is ${v.name} out of service? (for example: engine overhaul)`);
    if (reason == null) return;
    btn.disabled = true;
    await saveStatus(v, {
      outOfService: true,
      reason: reason.trim() || 'Out of service',
      since: new Date().toLocaleDateString('en-CA'),
    });
  });
  return btn;
}

function itemRow(v, r, showSchedule = false, { button = true } = {}) {
  const li = el('div', `item item-${r.status}`);
  const top = el('div', 'item-top');
  const name = el('div', 'item-name');
  if (STATUS_WORD[r.status]) name.append(el('span', `status status-${r.status}`, STATUS_WORD[r.status]));
  name.append(el('span', null, r.item.name));
  if (r.item.adjusted) name.append(el('span', 'badge', 'Adjusted'));
  top.append(name);
  li.append(top);
  if (showSchedule) li.append(el('div', 'item-meta', `${CATEGORY_LABEL[r.schedule.category] ?? ''} · ${r.schedule.name}`));
  li.append(el('div', `item-due when-${r.status}`, dueText(r)));
  li.append(el('div', 'item-meta', `${intervalText(r.item)} · ${lastText(r.last)}`));
  if (r.item.notes) li.append(el('div', 'item-meta', r.item.notes));
  if (r.item.tasks?.length) {
    const details = el('details', 'item-tasks');
    details.append(el('summary', null, `What's included (${r.item.tasks.length})`));
    const ul = el('ul');
    r.item.tasks.forEach((t) => ul.append(el('li', null, t)));
    details.append(ul);
    li.append(details);
  }
  if (button && r.status !== 'as-needed') {
    // Opens "Record work" with this item ticked, so every save goes through one form.
    const btn = el('button', 'btn btn-done', 'Record work');
    btn.type = 'button';
    btn.addEventListener('click', () => openWork(v.id, { keys: [r.key] }));
    li.append(btn);
  }
  return li;
}

function field(label, input) {
  const wrap = el('label', 'field');
  wrap.append(el('span', null, label), input);
  return wrap;
}

// ---- Shop view (main page) ----------------------------------------------------
// For mechanics: only the trucks that need work, most urgent first, each one
// a tap away from "Record work". English / Spanish.

const DUE = (r) => r.status === 'overdue' || r.status === 'soon';
const num = (n) => fmt.format(Math.abs(n));

// "32,966 mi overdue" / "in 4,000 mi", whichever runs out first, in the current language.
function dueWhen(r) {
  const options = [];
  if (r.milesLeft != null) options.push({ ratio: r.milesLeft / (r.item.intervalMiles || r.item.firstDueMiles), n: r.milesLeft, u: 'Miles' });
  if (r.hoursLeft != null) options.push({ ratio: r.hoursLeft / r.item.intervalHours, n: r.hoursLeft, u: 'Hours' });
  if (r.daysLeft != null) options.push({ ratio: r.daysLeft / (r.item.intervalMonths * 30.4), n: r.daysLeft, u: 'Days' });
  const o = options.sort((x, y) => x.ratio - y.ratio)[0];
  if (!o) return '';
  return o.n < 0 ? t(`${o.u.toLowerCase()}Overdue`, num(o.n)) : t(`in${o.u}`, num(o.n));
}

function dueLine(r, { meter: showMeter = true } = {}) {
  const line = el('div', `due-line due-${r.status}`);
  const text = el('div', 'due-text');
  text.append(el('span', 'due-name', shownName(r.item.name)), el('span', 'due-when', dueWhen(r)));
  if (r.last?.source === 'baseline') text.append(el('span', 'due-note', `(${t('noRecord')})`));
  // How much of the interval is used up: a full bar means it's due now.
  const used = r.status === 'overdue' ? 1 : Math.min(1, Math.max(0, 1 - (Number.isFinite(r.urgency) ? r.urgency : 1)));
  const meter = el('div', 'meter');
  const fill = el('i');
  fill.style.width = `${Math.round(used * 100)}%`;
  meter.append(fill);
  if (showMeter) text.append(meter);
  line.append(statusDot(r.status), text);
  return line;
}

// The shop view has two sides, Trucks and Trailers; each phone remembers the last one.
const SIDE_KEY = 'aslog.shopSide';
let shopSide = (() => {
  try { return localStorage.getItem(SIDE_KEY) === 'trailers' ? 'trailers' : 'trucks'; } catch { return 'trucks'; }
})();
function setShopSide(side) {
  shopSide = side === 'trailers' ? 'trailers' : 'trucks';
  try { localStorage.setItem(SIDE_KEY, shopSide); } catch { /* not remembered */ }
  renderShop();
  window.scrollTo(0, 0);
}

// Shop list sections: "In yard · needs service" starts open, the rest start
// folded to a one-line heading with a count. Each phone remembers what's open.
const OPEN_KEY = 'aslog.openSections';
const openSections = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY));
    if (saved?.trucks && saved?.trailers) return { trucks: new Set(saved.trucks), trailers: new Set(saved.trailers) };
  } catch { /* first visit or blocked */ }
  return { trucks: new Set(['yardWork']), trailers: new Set(['yardWork']) };
})();
function toggleSection(side, group) {
  const open = openSections[side];
  if (open.has(group)) open.delete(group); else open.add(group);
  try { localStorage.setItem(OPEN_KEY, JSON.stringify({ trucks: [...openSections.trucks], trailers: [...openSections.trailers] })); } catch { /* not remembered */ }
  renderShop();
}

// Headings and cards for entries already sorted by section (`entry.group`).
// `forceOpen` shows every section (while searching).
function sectionList(side, entries, labels, cardFor, { forceOpen = false } = {}) {
  const groups = Map.groupBy(entries, (e) => e.group);
  return [...groups].flatMap(([group, list]) => {
    const open = forceOpen || openSections[side].has(group);
    const head = el('button', `shop-group group-${group} section-toggle${open ? ' open' : ''}`);
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    head.append(el('span', 'section-label', labels[group]), el('span', 'section-count', String(list.length)), el('span', 'section-chevron', open ? '▾' : '▸'));
    if (!forceOpen) head.addEventListener('click', () => toggleSection(side, group));
    return [head, ...(open ? list.map(cardFor) : [])];
  });
}

const trailerInYard = (c) => atShop({ lat: c.latitude, lon: c.longitude, speedMph: c.speedMph });

function renderShop() {
  if (currentTab() !== 'shop') return;
  for (const b of document.querySelectorAll('#lang button')) b.classList.toggle('active', b.dataset.lang === getLang());
  $('admin-link').textContent = t('admin');
  // Sections, in the shop's order:
  //   1. in the yard and needs service   2. no GPS signal lately
  //   3. in the yard, nothing needed     4. needs service, not in the yard
  // "Needs service" is worked out in withMaintenance (same rule as admin).
  const flag = (x) => Number(Boolean(x));
  const needsService = ({ v }) => v.needsService;
  const groupOf = (entry) => {
    const { v } = entry;
    if (v.quiet != null && v.quiet >= QUIET_DAYS) return 'quiet';
    if (v.here) return needsService(entry) ? 'yardWork' : 'yardIdle';
    return needsService(entry) ? 'away' : null;
  };
  const ORDER = { yardWork: 0, quiet: 1, yardIdle: 2, away: 3 };
  const trucks = vehicles.map(withMaintenance)
    .map((v) => ({ v, due: v.rows.filter(DUE) }))
    .map((entry) => ({ ...entry, group: groupOf(entry) }))
    .filter((entry) => entry.group)
    .sort((a, b) => ORDER[a.group] - ORDER[b.group]
      || flag(b.v.faults?.stop) - flag(a.v.faults?.stop)
      || flag(b.due.some((r) => r.status === 'overdue')) - flag(a.due.some((r) => r.status === 'overdue'))
      || flag(b.due.length) - flag(a.due.length)
      || (a.due[0]?.urgency ?? 0) - (b.due[0]?.urgency ?? 0)
      || String(a.v.name).localeCompare(String(b.v.name), undefined, { numeric: true }));
  const needWork = trucks.filter(needsService).length;
  const inYard = trucks.filter((e) => e.group === 'yardWork' || e.group === 'yardIdle').length;

  const trailerRows = trailerList();
  const trailersNeedWork = trailerRows.filter((x) => x.worn.length).length;
  const yardTrailers = trailerRows.filter((x) => x.group === 'yardWork' || x.group === 'yardIdle').length;
  for (const b of document.querySelectorAll('#shop-side button')) {
    const on = b.dataset.side === shopSide;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.querySelector('.side-name').textContent = t(b.dataset.side === 'trucks' ? 'sideTrucks' : 'sideTrailers');
    b.querySelector('.side-count').textContent = b.dataset.side === 'trucks' ? (vehicles.length ? needWork : '') : (trailers.length ? trailersNeedWork : '');
  }
  $('shop-trucks').hidden = shopSide !== 'trucks';
  $('shop-trailers').hidden = shopSide !== 'trailers';
  const updated = lastSyncIso ? t('updated', agoText(lastSyncIso)) : '';
  $('shop-count').textContent = updated;
  if (shopSide === 'trailers') {
    $('shop-title').textContent = trailers.length ? t('trailersNeed', trailersNeedWork) : t('trailersTitle');
    $('shop-count').textContent = [yardTrailers ? t('inYardCount', yardTrailers) : null, updated].filter(Boolean).join(' · ');
    renderShopTrailers();
    return;
  }

  $('shop-title').textContent = vehicles.length ? (needWork ? t('shopCount', needWork) : t('shopEmpty')) : t('shopTitle');
  $('shop-count').textContent = [inYard ? t('inYardCount', inYard) : null, updated].filter(Boolean).join(' · ');
  $('shop-cards').replaceChildren(...sectionList('trucks', trucks, t('groups'), shopCard));
}

// Trailers side: every trailer, in the yard first, then on the road, then the
// ones Samsara hasn't heard from. Trailers have nothing "due", so each card
// shows where it is, its GPS miles and the last work recorded.
function renderShopTrailers() {
  const search = $('shop-tr-search');
  search.placeholder = t('searchTrailer');
  const q = search.value.trim().toLowerCase();
  // Same order as the trucks. Trailers on the road with nothing needed are
  // left out, but a search finds every trailer.
  const ORDER = { yardWork: 0, quiet: 1, yardIdle: 2, away: 3, road: 4 };
  const list = trailerList()
    .filter((x) => (q ? String(x.c.name).toLowerCase().includes(q) : x.group !== 'road'))
    .sort((a, b) => ORDER[a.group] - ORDER[b.group]
      || (b.worn[0] ? b.status[b.worn[0]].miles : 0) - (a.worn[0] ? a.status[a.worn[0]].miles : 0)
      || String(a.c.name).localeCompare(String(b.c.name), undefined, { numeric: true }));
  const cards = sectionList('trailers', list, t('trailerGroups'), trailerCard, { forceOpen: Boolean(q) });
  if (!cards.length) cards.push(el('p', 'muted', q ? t('noTrailerMatch') : t('shopEmpty')));
  $('shop-tr-cards').replaceChildren(...cards);
}

// Every trailer with its tires and its section. Needs work = a tire over the miles limit.
function trailerList() {
  return trailers.map((c) => {
    const status = tireStatus(trailerEntries(c.id), trailerMilesById[c.id]);
    const worn = tiresOverLimit(status, tireLimit());
    const here = trailerInYard(c);
    const group = isQuiet(c) ? 'quiet' : here ? (worn.length ? 'yardWork' : 'yardIdle') : worn.length ? 'away' : 'road';
    return { c, status, worn, here, group };
  });
}

// A compact row: the section heading already says where it is.
function trailerCard({ c, status, worn, group }) {
  const card = el('button', `trailer-row${worn.length ? ' needs-work' : ''}`);
  card.type = 'button';
  const m = trailerMilesById[c.id];
  const last = trailerEntries(c.id).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.loggedAtMs ?? 0) - (a.loggedAtMs ?? 0))[0];
  const info = el('span', 'trailer-info');
  info.append(el('span', 'trailer-miles', m ? `${fmt.format(Math.round(m.miles))} mi` : ''));
  if (worn.length) info.append(el('span', 'trailer-worn', t('tiresWorn', worn.length, worn[0], fmt.format(status[worn[0]].miles))));
  info.append(el('span', 'trailer-last', last ? t('lastWork', last.itemName, dateText(last.date)) : t('noHistory')));
  if ((group === 'away' || group === 'road') && c.location) info.append(el('span', 'trailer-where', c.location));
  if (group === 'quiet') info.append(el('span', 'trailer-where', t('noSignal', quietDays(c.lastReportedAt) ?? 7)));
  card.append(el('span', 'trailer-name', c.name), info, el('span', 'trailer-go', '›'));
  card.setAttribute('aria-label', `${t('trailer')} ${c.name}`);
  card.addEventListener('click', () => openTrailer(c.id));
  return card;
}

// One truck in the shop view: its number, flags, the code that matters, what's due.
function shopCard({ v, due }) {
  // A div, not a button, so it can hold the small Record work button.
  const card = el('div', `shop-card${due.some((r) => r.status === 'overdue') || v.faults?.stop ? ' has-overdue' : ''}`);
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.addEventListener('keydown', (e) => {
    if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTruck(v.id); }
  });
  const head = el('div', 'shop-card-head');
  const record = el('button', 'shop-record', t('logWork'));
  record.type = 'button';
  record.addEventListener('click', (e) => { e.stopPropagation(); openWork(v.id); });
  head.classList.add('with-record');
  head.append(el('span', 'shop-truck', v.name), record, el('span', 'shop-miles', v.odometerMiles == null ? '' : `${fmt.format(v.odometerMiles)} mi`));
  card.append(head);
  // One level of loudness: red only for a STOP lamp or something overdue.
  const badges = signalBadges(v, { lampsOnly: true });
  if (badges.length) {
    const row = el('div', 'shop-signals');
    row.append(...badges);
    card.append(row);
  }
  if (v.shop) {
    const label = [t('outOfService'), v.shop.reason].filter(Boolean).join(' · ');
    if (label) card.append(el('div', 'shop-oos', label));
  }
  // The codes that matter (a STOP lamp's code first), then what's due.
  // Kept short: one fault code and two due items (a bar on the first only), then "+N more".
  const codes = v.faults?.major ?? [];
  codes.slice(0, 1).forEach((c) => card.append(el('div', `fault-line${v.faults?.stop ? '' : ' fault-soft'}`, codeText(c))));
  due.slice(0, 2).forEach((r, i) => card.append(dueLine(r, { meter: i === 0 })));
  if (v.wornTires.length) {
    const top = v.wornTires[0];
    card.append(el('div', 'tire-worn-line', t('truckTiresWorn', v.wornTires.length, truckPositionName(top, getLang()), fmt.format(v.tires[top].miles))));
  }
  if (!due.length && !codes.length && !v.shop && !v.wornTires.length) card.append(el('div', 'due-none', t('nothingDue')));
  const hidden = Math.max(0, codes.length - 1) + Math.max(0, due.length - 2);
  if (hidden) card.append(el('div', 'due-more', t('more', hidden)));
  card.addEventListener('click', () => openTruck(v.id));
  return card;
}

// The truck's page, the same for the shop and admin: what's wrong, what's due,
// the Record work button, tires, recent work. Admin also gets a folded
// "More details" with every service, how it's used, out of service and the VIN.
function renderTruck(v) {
  if (!v) { $('truck').close(); return; }
  const admin = currentTab() !== 'shop';
  $('t-title').textContent = v.name;
  $('t-sub').textContent = [
    [v.year, titleCase(v.make || ''), titleCase(v.model || '')].filter(Boolean).join(' '),
    v.odometerMiles != null && `${fmt.format(v.odometerMiles)} mi`,
  ].filter(Boolean).join(' · ');
  $('t-close').textContent = t('close');
  const body = $('t-body');
  body.replaceChildren();

  // Where it is and its flags.
  const badges = signalBadges(v);
  if (badges.length) {
    const row = el('div', 'shop-signals');
    row.append(...badges);
    body.append(row);
  }
  if (v.shop) {
    body.append(admin ? shopBanner(v) : el('div', 'shop-oos', [t('outOfService'), v.shop.reason].filter(Boolean).join(' · ')));
  }
  if (!v.here && v.location?.address) body.append(el('p', 'muted truck-where', `📍 ${v.location.address}`));

  // 1. What's wrong.
  const codes = v.faults?.major ?? [];
  if (codes.length) {
    body.append(el('h3', 'section-title', t('activeFaults')));
    codes.forEach((c) => body.append(el('div', `fault-line${v.faults?.stop ? '' : ' fault-soft'}`, codeText(c))));
    const minor = v.faults?.minor?.length ?? 0;
    if (minor) body.append(el('div', 'due-more', t('minorCodes', minor)));
  }
  // 2. What's due.
  body.append(el('h3', 'section-title', t('dueHere')));
  const due = v.rows.filter(DUE);
  if (due.length) due.forEach((r) => body.append(dueLine(r)));
  else body.append(el('div', 'due-none', v.rows.length ? t('nothingDue') : t('noSchedule')));
  if (v.local) body.append(el('p', 'item-meta', t('localTruck')));
  // 3. The one button.
  const logBtn = el('button', 'btn btn-log', t('logWork'));
  logBtn.type = 'button';
  logBtn.addEventListener('click', () => openWork(v.id));
  body.append(logBtn);
  // 4. Tires.
  body.append(truckTiresSection(v));
  // 5. Recent work.
  body.append(el('h3', 'section-title', t('recentWork')));
  const visits = [...(visitsByTruck.get(v.id) ?? [])].filter((e) => e.type !== 'duty')
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.miles ?? 0) - (a.miles ?? 0)).slice(0, 5);
  if (!visits.length) body.append(el('p', 'muted', t('noHistory')));
  for (const e of visits) {
    const item = el('div', 'item');
    const name = el('div', 'item-name');
    if (e.type === 'repair') name.append(el('span', 'badge badge-repair', t('repair')), ' ');
    name.append(el('span', null, e.itemName ?? ''));
    item.append(name, el('div', 'item-meta', [e.date ? dateText(e.date) : null, e.miles != null && `${fmt.format(Math.round(e.miles))} mi`].filter(Boolean).join(' · ')));
    body.append(item);
  }
  if (!admin) return;

  // Admin: everything else, folded.
  const more = el('details', 'truck-more');
  more.append(el('summary', 'section-title', t('moreDetails')));
  if (v.rows.length) {
    const all = el('details', 'all-services');
    all.append(el('summary', 'section-title', `All services (${v.rows.length})`));
    for (const scheduleId of v.scheduleIds) {
      const schedule = schedules.get(scheduleId);
      const items = v.rows.filter((r) => r.schedule.id === scheduleId);
      if (!schedule || !items.length) continue;
      const section = el('section', 'sched');
      const head = el('div', 'sched-head');
      const duty = items[0]?.duty;
      const h3 = el('h3');
      h3.append(categoryTag(schedule), el('span', null, duty ? `${schedule.name} · ${dutyLabel(schedule.dutyModel, duty)}` : schedule.name));
      head.append(h3);
      const link = el('a', 'muted', 'Manual');
      Object.assign(link, { href: schedule.sourceUrl, target: '_blank', rel: 'noopener' });
      head.append(link);
      section.append(head);
      items.forEach((r) => section.append(itemRow(v, r, false, { button: false })));
      all.append(section);
    }
    more.append(all);
  } else if (v.scheduleIds?.length) {
    more.append(el('p', 'muted', 'Loading… If this stays empty, the next sync will set it up.'));
  } else {
    more.append(el('p', 'muted', v.local
      ? 'No maintenance schedule yet. Add its year, make and model to apply one.'
      : 'No maintenance schedule matches this truck.'));
  }
  const models = truckDutyModels(v);
  if (models.length) more.append(dutySection(v, models));
  if (!v.shop) more.append(shopButton(v));
  if (v.vin) more.append(vinRow(v.vin));
  body.append(more);
}

// ---- Record work ----------------------------------------------------------------
// One form for everything done on a truck in one visit: what's due on it, shop
// jobs (PM, oil change, ...), any single service, and repairs. A save writes
// the visit to the service log, which is what every due date is worked out from.

const LOGGED_BY_KEY = 'aslog.loggedBy';
function rememberedName() {
  try { return localStorage.getItem(LOGGED_BY_KEY) ?? ''; } catch { return ''; }
}
function rememberName(name) {
  try { localStorage.setItem(LOGGED_BY_KEY, name); } catch { /* private mode: not remembered */ }
}

// "schedule__item" -> the item's name, from the schedules. Items the fleet
// setup switches off (e.g. the no-frame-filter fuel filter) give null.
function itemNameFor(key) {
  const [scheduleId, itemId] = key.split('__');
  const item = schedules.get(scheduleId)?.items.find((i) => i.id === itemId);
  if (!item) return null;
  const s = settings();
  if (item.onlyWhen && !Object.entries(item.onlyWhen).every(([k, val]) => s[k] === val)) return null;
  return item.name;
}

// An item's name on screen: Spanish in the shop view when it's in Spanish.
// (itemNameFor and r.item.name stay English for the records.)
const shownName = (name) => itemName(name, activeLang());

// Job label (and hint) in the current language.
const jobLabel = (j) => t('jobs')[j.id]?.[0] ?? j.label;
const jobHint = (j) => t('jobs')[j.id]?.[1] ?? j.hint;
// Log text stays in English so the records read the same for everyone.
const jobText = (j) => (j.hint ? `${j.label} (${j.hint})` : j.label);

// The truck being logged, with its maintenance rows.
const workTruck = () => {
  const v = work?.vehicleId && vehicles.find((x) => x.id === work.vehicleId);
  return v ? withMaintenance(v) : null;
};

// Items the form will mark done: what the ticked jobs cover plus any ticked
// one by one, limited to items that apply to this truck, minus anything unticked.
function workKeys(v, { includeUnticked = false } = {}) {
  const applies = new Set(v.rows.map((r) => r.key));
  const fromJobs = JOBS.filter((j) => work.jobs.has(j.id)).flatMap((j) => itemKeysFor(v, j.tags, schedules));
  return [...new Set([...fromJobs, ...work.extra])]
    .filter((k) => applies.has(k) && (includeUnticked || !work.unticked.has(k)));
}

// Log line text: the job names when every item a job covers is saved, then
// any other items by name. A ticked job with no matching item (an air filter
// on a Cascadia) is still named, so the history shows the work.
function workSummary(v, keys) {
  const left = new Set(keys);
  const applies = new Set(v.rows.map((r) => r.key));
  const parts = [];
  for (const j of JOBS.filter((x) => work.jobs.has(x.id))) {
    const covers = itemKeysFor(v, j.tags, schedules).filter((k) => applies.has(k));
    if (covers.every((k) => left.has(k))) {
      parts.push(jobText(j));
      covers.forEach((k) => left.delete(k));
    }
  }
  for (const k of left) parts.push(itemNameFor(k) ?? k);
  return parts.join(', ');
}

function openWork(vehicleId, { keys = [] } = {}) {
  work = {
    vehicleId, jobs: new Set(), extra: new Set(keys), unticked: new Set(), days: null,
    tires: new Set(), parts: new Set(keys.length ? ['service'] : []),
  };
  buildWork();
  showDialog($('work'));
}

// Samsara's daily readings for the truck being logged (saved by the sync),
// loaded when the form opens. Local trucks have none.
async function loadDays(vehicleId) {
  try {
    const snap = await getDoc(doc(db, 'odometerDaily', vehicleId));
    return snap.data()?.days ?? {};
  } catch {
    return {}; // no check rather than a broken form
  }
}

function checkRow(text, checked, onChange, hint, extraClass = '') {
  const label = el('label', `check-row ${extraClass}`.trim());
  const box = Object.assign(el('input'), { type: 'checkbox', checked });
  box.addEventListener('change', () => onChange(box.checked));
  label.append(box, el('span', 'check-text', text));
  if (hint) label.append(el('span', 'check-hint', hint));
  return label;
}

function buildWork() {
  if (work?.kind === 'trailer') { buildTrailerWork(); return; }
  const v = workTruck();
  $('w-close').textContent = t('close');
  $('w-title').textContent = v ? v.name : t('logWork');
  $('w-sub').textContent = v
    ? [t('logWork'), v.odometerMiles != null && `${fmt.format(v.odometerMiles)} mi`].filter(Boolean).join(' · ')
    : t('pickTruck');
  const body = $('w-body');
  body.replaceChildren();

  // From "another truck" or the Log tab there's no truck yet.
  if (!work.vehicleId || !v) {
    const select = el('select', 'truck-pick');
    select.append(Object.assign(el('option', null, t('chooseTruck')), { value: '' }));
    [...vehicles].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }))
      .forEach((x) => select.append(Object.assign(el('option', null, x.name), { value: x.id })));
    select.addEventListener('change', () => { if (select.value) { work.vehicleId = select.value; work.days = null; buildWork(); } });
    body.append(field(t('truck'), select));
    return;
  }

  const shopMode = currentTab() === 'shop';
  const form = el('form', 'work-form');
  const today = new Date().toLocaleDateString('en-CA');
  const save = Object.assign(el('button', 'btn btn-save', t('save')), { type: 'submit' });

  // "What did you do?": Service, Tires, Repair. Only the picked parts show,
  // so an oil change never scrolls past the tire drawing.
  const on = (part) => work.parts.has(part);
  const parts = el('div', 'work-parts');
  const serviceBox = el('div', 'work-service');
  const tireBox = el('div', 'work-tires');
  const repairBox = el('div', 'repair-box');
  const PARTS = [['service', 'partService', 'partServiceHint'], ['tires', 'partTires', 'partTiresHint'], ['repair', 'partRepair', 'partRepairHint']];
  function drawParts() {
    parts.replaceChildren(el('div', 'section-title', t('whatDone')), ...PARTS.map(([id, label, hint]) => {
      const b = el('button', `part-tile${on(id) ? ' on' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on(id)));
      b.append(el('span', 'part-label', t(label)), el('span', 'part-hint', t(hint)));
      b.addEventListener('click', () => {
        if (on(id)) work.parts.delete(id); else work.parts.add(id);
        drawParts();
        showParts();
        refresh();
        if (id === 'repair' && on(id)) repairText.focus();
      });
      return b;
    }));
  }
  function showParts() {
    serviceBox.hidden = !on('service');
    tireBox.hidden = !on('tires');
    repairBox.hidden = !on('repair');
  }

  // Service: what's due (tap each one done), shop jobs, and any other item.
  function refresh() {
    const keys = workKeys(v);
    const applies = new Set(v.rows.map((r) => r.key));
    const due = v.rows.filter(DUE);
    serviceBox.replaceChildren();
    if (due.length) {
      serviceBox.append(el('div', 'section-title', t('dueHere')), el('p', 'muted', t('dueHint')));
      for (const r of due) {
        serviceBox.append(checkRow(shownName(r.item.name), keys.includes(r.key), (checked) => {
          if (checked) { work.extra.add(r.key); work.unticked.delete(r.key); } else { work.extra.delete(r.key); work.unticked.add(r.key); }
          refresh();
        }, [dueWhen(r), r.last?.source === 'baseline' && `(${t('noRecord')})`].filter(Boolean).join(' '), `due-${r.status}`));
      }
    }
    serviceBox.append(el('div', 'section-title', t('jobsTitle')));
    for (const j of JOBS) {
      // A ticked job says exactly what it marks done on this truck.
      const covers = itemKeysFor(v, j.tags, schedules).filter((k) => applies.has(k));
      const hint = work.jobs.has(j.id)
        ? (covers.length ? t('jobMarks', covers.map((k) => shownName(itemNameFor(k) ?? k)).join(', ')) : t('nothingOnSchedule'))
        : jobHint(j);
      serviceBox.append(checkRow(jobLabel(j), work.jobs.has(j.id), (checked) => {
        if (checked) work.jobs.add(j.id); else work.jobs.delete(j.id);
        refresh();
      }, hint));
    }
    // Other items added one by one (not due, not part of a job).
    const dueKeys = new Set(due.map((r) => r.key));
    for (const k of [...work.extra].filter((x) => !dueKeys.has(x))) {
      serviceBox.append(checkRow(shownName(itemNameFor(k) ?? k), true, () => { work.extra.delete(k); refresh(); }));
    }
    const shown = new Set([...dueKeys, ...workKeys(v, { includeUnticked: true })]);
    const others = v.rows.filter((r) => !shown.has(r.key));
    if (others.length) {
      const add = el('select', 'add-item');
      add.append(Object.assign(el('option', null, t('addService')), { value: '' }));
      others.forEach((r) => add.append(Object.assign(el('option', null, shownName(r.item.name)), { value: r.key })));
      add.addEventListener('change', () => { if (add.value) { work.extra.add(add.value); work.unticked.delete(add.value); refresh(); } });
      serviceBox.append(add);
    }
    const n = (on('service') ? keys.length : 0) + (on('repair') ? 1 : 0) + (on('tires') ? work.tires.size : 0);
    save.textContent = n ? t('saveCount', n, v.name) : t('save');
  }

  // Tires: tap each position that was replaced (flats are replaced too).
  function drawTires() {
    tireBox.replaceChildren(
      el('div', 'section-title', t('tiresSection')),
      el('p', 'muted', t('tapTruckTires')),
      truckTireDiagram(v, {
        selected: work.tires,
        onToggle: (pos) => { if (work.tires.has(pos)) work.tires.delete(pos); else work.tires.add(pos); drawTires(); refresh(); },
      }),
    );
  }

  // Repair: what was done, and which fault codes it fixed.
  const repairText = Object.assign(el('textarea'), { rows: 2, placeholder: t('repairPlaceholder') });
  repairBox.append(field(t('repair'), repairText));
  const fixedCodes = new Set();
  if (v.faults?.major.length) {
    const box = el('div', 'fixed-codes');
    box.append(el('div', 'section-title', t('fixedCodes')));
    v.faults.major.forEach((c) => box.append(checkRow(codeText(c), false, (checked) => {
      if (checked) fixedCodes.add(codeId(c)); else fixedCodes.delete(codeId(c));
    })));
    repairBox.append(box);
  }

  // 4. Miles and date: from Samsara, shown as text with a "Change" link, so
  // the usual same-day log needs no typing.
  const miles = Object.assign(el('input'), { type: 'number', min: 0, required: true, inputMode: 'numeric', value: v.odometerMiles ?? '' });
  const date = Object.assign(el('input'), { type: 'date', required: true, max: today, value: today });
  const hours = Object.assign(el('input'), { type: 'number', min: 0, inputMode: 'numeric', value: v.engineHours ?? '' });
  const note = Object.assign(el('input'), { type: 'text', placeholder: t('notePlaceholder') });
  const who = Object.assign(el('input'), { type: 'text', placeholder: t('yourName'), value: rememberedName(), autocomplete: 'name' });

  const fixed = (label, input, textFor) => {
    const wrap = el('div', 'field fixed-field');
    const shown = el('div', 'fixed-value');
    const value = el('span', 'fixed-text');
    const changeBtn = Object.assign(el('button', 'link-btn', t('change')), { type: 'button' });
    shown.append(value, changeBtn);
    input.hidden = true;
    changeBtn.addEventListener('click', () => { input.hidden = false; shown.hidden = true; input.focus(); });
    wrap.append(el('span', null, label), shown, input);
    const update = () => { value.textContent = textFor(); };
    update();
    return { wrap, update, edit: () => changeBtn.click() };
  };
  let milesSource = v.local ? 'typed' : 'samsara';
  let milesNote = v.local ? '' : t('fromSamsara');
  const milesField = fixed(t('miles'), miles, () => `${miles.value ? fmt.format(Number(miles.value)) : '—'} mi${milesNote ? ` · ${milesNote}` : ''}`);
  const dateField = fixed(t('date'), date, () => (date.value === today ? t('today') : dateText(date.value)));
  const milesHint = el('span', 'samsara-hint');
  milesField.wrap.append(milesHint);
  if (v.local || v.odometerMiles == null) milesField.edit();
  miles.addEventListener('input', () => { milesSource = 'typed'; });
  hours.addEventListener('input', () => { milesSource = 'typed'; });

  // A past date fills in Samsara's reading for that day.
  function applyDate() {
    dateField.update();
    if (v.local || !work.days) return;
    if (date.value === today) {
      miles.value = v.odometerMiles ?? '';
      hours.value = v.engineHours ?? '';
      milesSource = 'samsara';
      milesNote = t('fromSamsara');
    } else {
      const near = readingsNear(work.days, date.value);
      if (near?.reading) {
        miles.value = near.reading.miles;
        hours.value = near.reading.hours ?? '';
        milesSource = 'samsara';
        milesNote = t('fromSamsaraFor', dateText(date.value));
      } else {
        milesNote = '';
        milesField.edit();
        milesHint.textContent = t('noSamsaraFor', dateText(date.value));
        milesField.update();
        return;
      }
    }
    milesHint.textContent = '';
    milesField.update();
  }
  date.addEventListener('change', applyDate);
  if (!v.local && !work.days) {
    const forTruck = v.id;
    loadDays(forTruck).then((d) => {
      if (work?.vehicleId !== forTruck) return;
      work.days = d;
      applyDate();
    });
  }

  const details = el('div', 'work-details');
  details.append(milesField.wrap, dateField.wrap);
  // Engine hours are wrong on several trucks in Samsara; mechanics don't need them.
  if (!shopMode) details.append(field(t('hours'), hours));
  const wide = (f) => { f.classList.add('wide'); return f; };
  details.append(wide(field(t('note'), note)), wide(field(t('loggedBy'), who)));

  const error = el('p', 'form-error');
  error.hidden = true;
  const cancel = Object.assign(el('button', 'btn btn-ghost btn-cancel', t('cancel')), { type: 'button' });
  cancel.addEventListener('click', () => $('work').close());
  const faultBox = faultsBox(v, { showMinor: false });
  // Save stays at the bottom of the screen while scrolling.
  const actions = el('div', 'work-actions');
  actions.append(error, save, cancel);
  form.append(...(faultBox ? [faultBox] : []), parts, serviceBox, tireBox, repairBox, details, actions);
  body.append(form);
  drawParts();
  showParts();
  drawTires();
  refresh();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fail = (msg) => { error.textContent = msg; error.hidden = false; error.scrollIntoView({ block: 'nearest' }); };
    // Only the picked parts are saved (a part tapped off keeps its ticks hidden, not saved).
    const service = on('service');
    const keys = service ? workKeys(v) : [];
    const jobsDone = service ? work.jobs.size : 0;
    const doRepair = on('repair');
    const tires = on('tires') ? TRUCK_TIRE_POSITIONS.filter((p) => work.tires.has(p)) : [];
    const m = Number(miles.value);
    const repair = repairText.value.trim();
    // Catch typos before they're saved.
    if (!keys.length && !jobsDone && !doRepair && !tires.length) return fail(t('errTick'));
    if (doRepair && !repair) return fail(t('errRepair'));
    if (date.value > today) return fail(t('errFuture'));
    if (!v.local && v.odometerMiles != null && m > v.odometerMiles + 500) return fail(t('errTooHigh', fmt.format(v.odometerMiles)));
    // Back-dated work: compare with what Samsara recorded around that day.
    const off = !v.local && milesSource === 'typed' && milesMismatch(work.days, date.value, m);
    if (off && !confirm(t('confirmSamsara', v.name, off.lo === off.hi ? fmt.format(off.lo) : `${fmt.format(off.lo)}–${fmt.format(off.hi)}`,
      dateText(date.value), fmt.format(m)))) return;
    const older = v.rows.filter((r) => keys.includes(r.key) && r.last?.source === 'done' && m < r.last.miles);
    if (older.length && !confirm(t('confirmOlder', older.map((r) => shownName(r.item.name)).join(', '), fmt.format(older[0].last.miles)))) return;

    save.disabled = true;
    save.textContent = t('saving');
    const loggedBy = who.value.trim();
    if (loggedBy) rememberName(loggedBy);
    const common = {
      vehicleId: v.id,
      vehicleName: v.name,
      date: date.value,
      miles: m,
      hours: shopMode && milesSource === 'typed' ? null : (hours.value === '' ? null : Number(hours.value)),
      note: note.value.trim(),
      loggedBy: loggedBy || null,
      milesSource,
      source: 'app',
      loggedAt: serverTimestamp(),
    };
    // All or nothing: the service line, the repair line, and a local truck's miles.
    const batch = writeBatch(db);
    const refs = [];
    if (keys.length || jobsDone) {
      const ref = doc(collection(db, 'serviceLog'));
      batch.set(ref, { ...common, services: keys, itemName: workSummary(v, keys) });
      refs.push(ref);
    }
    if (doRepair) {
      const ref = doc(collection(db, 'serviceLog'));
      batch.set(ref, {
        ...common, type: 'repair', services: [], itemName: repair, faultsFixed: [...fixedCodes],
      });
      refs.push(ref);
    }
    if (tires.length) {
      const order = tires;
      const ref = doc(collection(db, 'serviceLog'));
      // Log text stays in English, like the other records.
      batch.set(ref, {
        ...common, type: 'tires', services: [], tires: order,
        itemName: `Tires replaced: ${order.map((p) => truckPositionName(p, 'en')).join(', ')}`,
      });
      refs.push(ref);
    }
    // Local trucks aren't in Samsara: a logged visit is how their miles move.
    const oldMiles = v.local ? { odometerMiles: v.odometerMiles ?? null, odometerTime: v.odometerTime ?? null } : null;
    if (v.local && m > (v.odometerMiles ?? -1)) {
      batch.set(doc(db, 'vehicles', v.id), { odometerMiles: m, odometerTime: date.value }, { merge: true });
    }
    try {
      await batch.commit();
      const summary = [keys.length || jobsDone ? workSummary(v, keys) : null, doRepair ? t('repairWord') : null,
        tires.length ? t('tiresSection').toLowerCase() : null].filter(Boolean).join(' + ');
      $('work').close();
      showUndo(t('saved', v.name, summary), async () => {
        const undo = writeBatch(db);
        refs.forEach((ref) => undo.delete(ref));
        if (oldMiles && m > (oldMiles.odometerMiles ?? -1)) undo.set(doc(db, 'vehicles', v.id), oldMiles, { merge: true });
        await undo.commit();
      });
    } catch (err) {
      save.disabled = false;
      refresh();
      fail(t('couldNotSave', err.message));
    }
  });
}

// ---- Trailers: popup, tire positions, Record trailer work -----------------------
// Trailers only get tire changes and repairs. Tires are tracked by position
// (8 on a tandem with duals); their miles come from the trailer's GPS miles.

const trailerEntries = (id) => serviceLog.filter((e) => e.assetType === 'trailer' && e.vehicleId === id);
const trailerById = (id) => trailers.find((x) => x.id === id);

// Top-down drawing: front at the top, driver side (left) on the left.
// Each tile shows its position and the miles on that tire; in the form a tap selects it.
// `layout` is one row per axle: { label, left: [positions], right: [positions] }.
const trailerLayout = () => ['1', '2'].map((n) => ({ label: `${t('axle')} ${n}`, left: [`${n}LO`, `${n}LI`], right: [`${n}RI`, `${n}RO`] }));
const truckLayout = () => [
  { label: t('steerShort'), left: ['SL'], right: ['SR'] },
  ...['1', '2'].map((n) => ({ label: `${t('driveShort')} ${n}`, left: [`${n}LO`, `${n}LI`], right: [`${n}RI`, `${n}RO`] })),
];

function tireDiagram(status, {
  selected = null, onToggle = null, layout = trailerLayout(), nameOf = positionName,
  isWorn = (pos, st) => st?.miles != null && st.miles >= tireLimit(),
} = {}) {
  const wrap = el('div', 'tire-diagram');
  wrap.append(el('div', 'tire-front', `▲ ${t('front')}`));
  const head = el('div', 'tire-row tire-head');
  head.append(el('span'), el('span', 'tire-side', t('left')), el('span', 'tire-gap'), el('span', 'tire-side', t('right')));
  wrap.append(head);
  for (const axle of layout) {
    const row = el('div', 'tire-row');
    row.append(el('span', 'tire-axle', axle.label));
    const side = (positions) => {
      const g = el('div', `tire-pair${positions.length === 1 ? ' single' : ''}`);
      for (const pos of positions) {
        const st = status[pos];
        const tile = el(onToggle ? 'button' : 'div', `tire${selected?.has(pos) ? ' on' : ''}${st?.recorded ? '' : ' unrecorded'}${isWorn(pos, st) ? ' worn' : ''}`);
        if (onToggle) {
          tile.type = 'button';
          tile.setAttribute('aria-pressed', String(Boolean(selected?.has(pos))));
          tile.addEventListener('click', () => onToggle(pos));
        }
        tile.title = nameOf(pos, getLang());
        const dual = pos.length === 3;
        tile.append(
          el('span', 'tire-pos', dual ? (pos[2] === 'O' ? t('outerShort') : t('innerShort')) : axle.label),
          el('span', 'tire-mi', st?.miles != null ? `${fmt.format(st.miles)} mi` : '—'),
        );
        if (st && !st.recorded) tile.append(el('span', 'tire-note', t('noRecordShort')));
        else if (st?.since) tile.append(el('span', 'tire-note', dateText(st.since)));
        g.append(tile);
      }
      return g;
    };
    row.append(side(axle.left), el('span', 'tire-gap'), side(axle.right));
    wrap.append(row);
  }
  return wrap;
}

// A truck's tire drawing, with its own steer / drive limits.
const truckTireDiagram = (v, opts = {}) => tireDiagram(v.tires, {
  ...opts,
  layout: truckLayout(),
  nameOf: truckPositionName,
  isWorn: (pos, st) => st?.miles != null && st.miles >= limitFor(pos, truckTireLimits()),
});

// Truck page section: the drawing plus where the miles start.
function truckTiresSection(v) {
  const box = el('section', 'truck-tires');
  box.append(el('h3', 'section-title', t('tiresTitle')), truckTireDiagram(v));
  const start = truckTireStarts[v.id];
  box.append(el('p', 'item-meta', start ? t('truckTiresStart', dateText(start.startedAt)) : t('truckTiresSoon')));
  return box;
}

function openTrailer(id) {
  openTrailerId = id;
  openTruckId = null;
  renderTrailer();
  showDialog($('truck'));
}

function renderTrailer() {
  const c = trailerById(openTrailerId);
  if (!c) { $('truck').close(); return; }
  const m = trailerMilesById[c.id];
  $('t-title').textContent = c.name;
  $('t-close').textContent = t('close');
  $('t-sub').textContent = [t('trailer'), m ? t('trailerMiles', fmt.format(Math.round(m.miles)), dateText(m.startedAt)) : null].filter(Boolean).join(' · ');
  const body = $('t-body');
  body.replaceChildren();
  const btn = el('button', 'btn btn-log', t('trailerWork'));
  btn.type = 'button';
  btn.addEventListener('click', () => openTrailerWork(c.id));
  body.append(btn);
  const here = atShop({ lat: c.latitude, lon: c.longitude, speedMph: c.speedMph });
  body.append(el('p', 'muted truck-where', `📍 ${here ? t('atShop') : c.location || '—'} · ${timeAgo(c.lastReportedAt)}`));
  body.append(el('h3', 'section-title', t('tiresTitle')), tireDiagram(tireStatus(trailerEntries(c.id), m)));
  if (m) body.append(el('p', 'item-meta', t('milesStart', dateText(m.startedAt))));
  body.append(el('h3', 'section-title', t('history')));
  const entries = trailerEntries(c.id).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.loggedAtMs ?? 0) - (a.loggedAtMs ?? 0));
  if (!entries.length) body.append(el('p', 'muted', t('noHistory')));
  for (const e of entries.slice(0, 20)) {
    const item = el('div', 'item');
    const name = el('div', 'item-name');
    if (e.type === 'repair') name.append(el('span', 'badge badge-repair', t('repair')), ' ');
    name.append(el('span', null, e.itemName));
    item.append(name, el('div', 'item-meta', [dateText(e.date), e.miles != null && `${fmt.format(Math.round(e.miles))} mi`,
      e.loggedBy, e.note].filter(Boolean).join(' · ')));
    body.append(item);
  }
}

function openTrailerWork(trailerId) {
  work = { kind: 'trailer', trailerId, tires: new Set(), repair: false };
  buildWork();
  showDialog($('work'));
}

function buildTrailerWork() {
  const c = work.trailerId && trailerById(work.trailerId);
  $('w-close').textContent = t('close');
  $('w-title').textContent = c ? c.name : t('trailerWork');
  const m = c && trailerMilesById[c.id];
  $('w-sub').textContent = c ? [t('trailerWork'), m && `${fmt.format(Math.round(m.miles))} mi`].filter(Boolean).join(' · ') : t('pickTrailer');
  const body = $('w-body');
  body.replaceChildren();

  // No trailer yet: pick one (trailers parked in the yard first).
  if (!c) {
    const select = el('select', 'truck-pick');
    select.append(Object.assign(el('option', null, t('chooseTrailer')), { value: '' }));
    const inYard = (x) => atShop({ lat: x.latitude, lon: x.longitude, speedMph: x.speedMph });
    [...trailers].sort((a, b) => Number(inYard(b)) - Number(inYard(a))
      || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }))
      .forEach((x) => select.append(Object.assign(el('option', null, `${x.name}${inYard(x) ? ` · ${t('atShop')}` : ''}`), { value: x.id })));
    select.addEventListener('change', () => { if (select.value) { work.trailerId = select.value; buildWork(); } });
    body.append(field(t('trailer'), select));
    return;
  }

  const form = el('form', 'work-form');
  const today = new Date().toLocaleDateString('en-CA');
  const save = Object.assign(el('button', 'btn btn-save', t('save')), { type: 'submit' });
  const status = tireStatus(trailerEntries(c.id), m);

  // 1. Tires changed: tap the tiles.
  const tires = el('div', 'work-tires');
  const drawTires = () => {
    tires.replaceChildren(el('div', 'section-title', t('tiresChanged')), el('p', 'muted', t('tapTires')),
      tireDiagram(status, {
        selected: work.tires,
        onToggle: (pos) => { if (work.tires.has(pos)) work.tires.delete(pos); else work.tires.add(pos); drawTires(); count(); },
      }));
  };
  // 2. Repairs.
  const jobs = el('fieldset', 'work-jobs');
  const repairBox = el('div', 'repair-box');
  const repairText = Object.assign(el('textarea'), { rows: 2, placeholder: t('repairPlaceholder') });
  repairBox.append(field(t('repair'), repairText));
  repairBox.hidden = true;
  jobs.append(checkRow(t('repairOther'), false, (on) => {
    work.repair = on;
    repairBox.hidden = !on;
    if (on) repairText.focus();
    count();
  }), repairBox);
  // 3. When and who.
  const date = Object.assign(el('input'), { type: 'date', required: true, max: today, value: today });
  const note = Object.assign(el('input'), { type: 'text', placeholder: t('notePlaceholder') });
  const who = Object.assign(el('input'), { type: 'text', placeholder: t('yourName'), value: rememberedName(), autocomplete: 'name' });
  const wide = (f) => { f.classList.add('wide'); return f; };
  const details = el('div', 'work-details');
  details.append(wide(field(t('date'), date)), wide(field(t('note'), note)), wide(field(t('loggedBy'), who)));
  const error = el('p', 'form-error');
  error.hidden = true;
  const cancel = Object.assign(el('button', 'btn btn-ghost btn-cancel', t('cancel')), { type: 'button' });
  cancel.addEventListener('click', () => $('work').close());
  const actions = el('div', 'work-actions');
  actions.append(error, save, cancel);
  form.append(tires, jobs, details, actions);
  body.append(form);
  function count() {
    const n = work.tires.size + (work.repair ? 1 : 0);
    save.textContent = n ? t('saveCount', n, c.name) : t('save');
  }
  drawTires();
  count();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fail = (msg) => { error.textContent = msg; error.hidden = false; error.scrollIntoView({ block: 'nearest' }); };
    const repair = repairText.value.trim();
    if (!work.tires.size && !work.repair) return fail(t('errTrailer'));
    if (work.repair && !repair) return fail(t('errRepair'));
    if (date.value > today) return fail(t('errFuture'));
    save.disabled = true;
    save.textContent = t('saving');
    const loggedBy = who.value.trim();
    if (loggedBy) rememberName(loggedBy);
    const common = {
      assetType: 'trailer',
      vehicleId: c.id,
      vehicleName: c.name,
      date: date.value,
      miles: Math.round(milesOn(m, date.value)),
      hours: null,
      note: note.value.trim(),
      loggedBy: loggedBy || null,
      milesSource: 'samsara-gps',
      source: 'app',
      services: [],
      loggedAt: serverTimestamp(),
    };
    const batch = writeBatch(db);
    const refs = [];
    if (work.tires.size) {
      const order = TIRE_POSITIONS.filter((p) => work.tires.has(p));
      const ref = doc(collection(db, 'serviceLog'));
      // Log text stays in English, like the truck records.
      batch.set(ref, { ...common, tires: order, itemName: `Tires changed: ${order.map((p) => positionName(p, 'en')).join(', ')}` });
      refs.push(ref);
    }
    if (work.repair) {
      const ref = doc(collection(db, 'serviceLog'));
      batch.set(ref, { ...common, type: 'repair', itemName: repair });
      refs.push(ref);
    }
    // Worked out before closing the form (closing clears `work`).
    const summary = [work.tires.size ? t('tiresChanged') : null, work.repair ? t('repairWord') : null].filter(Boolean).join(' + ');
    try {
      await batch.commit();
      $('work').close();
      showUndo(t('saved', c.name, summary), async () => {
        const undo = writeBatch(db);
        refs.forEach((ref) => undo.delete(ref));
        await undo.commit();
      });
    } catch (err) {
      save.disabled = false;
      count();
      fail(t('couldNotSave', err.message));
    }
  });
}

// A message bar with an Undo button that disappears after 10 seconds.
let undoTimer;
function showUndo(message, undo) {
  const bar = $('toast');
  clearTimeout(undoTimer);
  const btn = el('button', 'btn btn-undo', t('undo'));
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await undo();
      bar.replaceChildren(el('span', null, t('undone')));
      undoTimer = setTimeout(() => { bar.hidden = true; }, 2500);
    } catch (err) {
      showAppError(`Could not undo: ${err.message}`);
    }
  });
  bar.replaceChildren(el('span', null, message), btn);
  // An open popup sits above the page, so the bar goes inside it.
  const host = [$('work'), $('truck'), $('schedule')].find((d) => d.open) ?? document.body;
  if (bar.parentElement !== host) host.append(bar);
  bar.hidden = false;
  undoTimer = setTimeout(() => { bar.hidden = true; }, 10000);
}

function watchFleet() {
  unsubscribers.push(
    onSnapshot(
      collection(db, 'vehicles'),
      { includeMetadataChanges: true },
      (snap) => {
        // An empty result from the local cache just means we haven't
        // reached Firestore yet; keep showing "Loading…".
        if (snap.empty && snap.metadata.fromCache) return;
        vehicles = snap.docs.map((d) => d.data());
        show('fleet');
        render();
      },
      (err) => {
        console.error(err);
        if (err.code === 'permission-denied' && requireSignIn) show('not-allowed');
        else if (err.code === 'permission-denied') {
          showAppError('Firestore blocked the read. Check the rules in Firebase → Firestore Database → Rules.');
        } else showAppError(err.message);
      },
    ),
    onSnapshot(collection(db, 'maintenanceSchedules'), (snap) => {
      schedules = new Map(snap.docs.map((d) => [d.id, d.data()]));
      render();
    }, (err) => console.error(err)),
    onSnapshot(collection(db, 'serviceRecords'), (snap) => {
      records = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
      render();
    }, (err) => console.error(err)),
    onSnapshot(collection(db, 'trailers'), (snap) => {
      trailers = snap.docs.map((d) => d.data());
      renderTrailers();
      renderShop();
      if (openTrailerId) renderTrailer();
    }, (err) => console.error(err)),
    onSnapshot(collection(db, 'truckTires'), (snap) => {
      truckTireStarts = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
      render();
    }, (err) => console.error(err)),
    onSnapshot(collection(db, 'trailerMiles'), (snap) => {
      trailerMilesById = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
      renderTrailers();
      renderShop();
      if (openTrailerId) renderTrailer();
    }, (err) => console.error(err)),
    onSnapshot(collection(db, 'serviceLog'), (snap) => {
      serviceLog = snap.docs.map((d) => {
        const e = d.data();
        return { ...e, id: d.id, loggedAtMs: e.loggedAt?.toMillis?.() ?? 0 };
      });
      visitsByTruck = Map.groupBy(serviceLog, (e) => e.vehicleId);
      render();
    }, (err) => console.error(err)),
    onSnapshot(collection(db, 'vehicleStatus'), (snap) => {
      statusDocs = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
      render();
    }, (err) => console.error(err)),
    onSnapshot(collection(db, 'dutyCycles'), (snap) => {
      dutyDocs = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
      render();
    }, (err) => console.error(err)),
    onSnapshot(doc(db, 'meta', 'settings'), (snap) => {
      savedSettings = snap.data() ?? {};
      render();
    }, (err) => console.error(err)),
    onSnapshot(doc(db, 'meta', 'schedules'), (snap) => {
      assignments = snap.data() ?? null;
      render();
    }, (err) => console.error(err)),
    onSnapshot(doc(db, 'meta', 'sync'), (snap) => {
      const t = snap.data()?.lastRun?.toDate();
      lastSyncIso = t ? t.toISOString() : null;
      $('last-sync').textContent = t ? `Updated ${timeAgo(lastSyncIso)}` : '';
      renderShop();
    }, () => {}),
  );
}

// Prototype mode: no sign-in, the fleet loads right away (the Firestore
// rules must allow public reads). Set requireSignIn = true to lock it down.
if (!requireSignIn) {
  show('loading');
  watchFleet();
}
else onAuthStateChanged(auth, (user) => {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  $('user-box').hidden = !user;
  if (!user) {
    show('signed-out');
    return;
  }
  $('user-email').textContent = user.email;
  watchFleet();
});

$('sign-in').addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user') return;
    if (err.code === 'auth/unauthorized-domain') {
      showAppError(`${location.hostname} isn't an authorized domain. Add it in Firebase → Authentication → Settings → Authorized domains.`);
    } else {
      showAppError(err.message);
    }
  }
});
$('sign-out').addEventListener('click', () => signOut(auth));
$('search').addEventListener('input', render);
addEventListener('hashchange', () => {
  const tab = location.hash.slice(1);
  if (TABS.includes(tab) && tab !== 'shop' && !adminUnlocked()) askAdminPassword();
  showTab();
  render();
});
$('admin-lock').addEventListener('submit', (e) => {
  e.preventDefault();
  if ($('admin-pass').value.trim().toLowerCase() !== ADMIN_PASSWORD.toLowerCase()) {
    $('admin-pass-error').hidden = false;
    $('admin-pass').select();
    return;
  }
  try { localStorage.setItem(ADMIN_KEY, 'yes'); } catch { /* asked again next time */ }
  $('admin-lock').close('ok');
  showTab();
  render();
});
$('admin-pass-cancel').addEventListener('click', () => $('admin-lock').close());
// Closed without the password (Cancel or Esc): back to the shop view.
$('admin-lock').addEventListener('close', () => {
  if (!adminUnlocked()) history.replaceState(null, '', location.pathname + location.search);
  showTab();
  render();
});
for (const b of document.querySelectorAll('#lang button')) {
  b.addEventListener('click', () => { setLang(b.dataset.lang); render(); });
}
$('tr-search').addEventListener('input', renderTrailers);
for (const th of document.querySelectorAll('th[data-trsort]')) {
  th.addEventListener('click', () => {
    trSortDir = trSortKey === th.dataset.trsort ? -trSortDir : 1;
    trSortKey = th.dataset.trsort;
    renderTrailers();
  });
}
$('log-period').addEventListener('change', () => { applyLogPeriod(); renderLog(); });
for (const id of ['log-from', 'log-to']) {
  $(id).addEventListener('change', () => { $('log-period').value = 'custom'; renderLog(); });
}
$('log-unit').addEventListener('change', renderLog);
$('log-auto').addEventListener('change', renderLog);
$('log-pdf').addEventListener('click', () => exportLog($('log-pdf')));
$('company-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter ?? $('company-form').querySelector('button');
  btn.disabled = true;
  try {
    await setDoc(doc(db, 'meta', 'settings'), {
      companyName: $('company-name').value.trim(),
      usdot: $('company-usdot').value.trim(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    btn.textContent = 'Saved';
    setTimeout(() => { btn.textContent = 'Save company info'; }, 2000);
  } catch (err) {
    showAppError(`Could not save: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
$('tires-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter ?? $('tires-form').querySelector('button');
  const value = (id) => Math.round(Number($(id).value));
  const ids = ['tire-limit-steer', 'tire-limit-drive', 'tire-limit'];
  const bad = ids.find((id) => !(value(id) >= 10000 && value(id) <= 500000));
  if (bad) { $(bad).reportValidity(); return; }
  btn.disabled = true;
  try {
    await setDoc(doc(db, 'meta', 'settings'), {
      tireMilesSteer: value('tire-limit-steer'),
      tireMilesDrive: value('tire-limit-drive'),
      tireMilesLimit: value('tire-limit'),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    btn.textContent = 'Saved';
    setTimeout(() => { btn.textContent = 'Save tire limits'; }, 2000);
  } catch (err) {
    showAppError(`Could not save: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
applyLogPeriod();
if (TABS.includes(location.hash.slice(1)) && location.hash.slice(1) !== 'shop' && !adminUnlocked()) askAdminPassword();
showTab();
$('t-close').addEventListener('click', () => $('truck').close());
$('s-close').addEventListener('click', () => $('schedule').close());
$('schedule').addEventListener('close', () => { openGroupKey = null; });
$('schedule').addEventListener('click', (e) => { if (e.target === $('schedule')) $('schedule').close(); });
$('truck').addEventListener('close', () => { openTruckId = null; openTrailerId = null; });
for (const b of document.querySelectorAll('#shop-side button')) b.addEventListener('click', () => setShopSide(b.dataset.side));
$('shop-tr-search').addEventListener('input', () => renderShopTrailers());
$('w-close').addEventListener('click', () => $('work').close());
$('work').addEventListener('close', () => { work = null; });
$('log-add').addEventListener('click', () => openWork(null));
// Clicking the dimmed backdrop closes the dialog.
$('truck').addEventListener('click', (e) => { if (e.target === $('truck')) $('truck').close(); });
for (const th of document.querySelectorAll('th[data-sort]')) {
  th.addEventListener('click', () => {
    sortDir = sortKey === th.dataset.sort ? -sortDir : 1;
    sortKey = th.dataset.sort;
    render();
  });
}
