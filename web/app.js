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
  AUTO_USES, KIT_TAGS, batteryParts, kitCategory, kitKey, kitParts, onHand, shoppingList, tagsForJobs,
  tagsForKeys, tireParts, upcomingWork,
} from './parts.js';
import {
  activeLang, agoText, clockText, dateText, dateTimeText, getLang, setLang, t, useEnglish,
} from './i18n.js';
import {
  QUIET_DAYS, atShop, codeId, codeText, faultSummary, quietDays,
} from './signals.js';
import { downloadLog, downloadTruckRecord } from './records.js';
import {
  POOL_KINDS, SHOP_KINDS, accuracy, auditQueue, costEvents, daysBetween, inWindow, isRepair, itemKey, landedCosts,
  lineKind, oldStock, openItems, receiptItems, receiptMatch, receiptWork, repairText, shopShare, spending, stockLots,
} from './items.js';
import { fleetBreakdown, periodsFor, unitBreakdown, workKind } from './analytics.js';

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
let partsList = []; // parts docs: the shelf (oil, filters, tires, batteries…)
let kits = {}; // meta/kits doc: { [kitKey]: { [tag]: [{ part, qty }] } }
let receipts = []; // receipts docs (createdMs from createdAt)
let itemUses = []; // itemUses docs: which repair each bought item went into (items.js)
let aiMemory = {}; // meta/aiMemory doc: { notes } admin writes for the AI
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
  renderParts();
  renderAnalytics();
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
const TABS = ['shop', 'inventory', 'trucks', 'trailers', 'parts', 'analytics', 'schedules', 'log', 'settings'];
// The inventory person's page is the admin Parts tab, in the shop look.
const viewOf = (tab) => (tab === 'inventory' ? 'parts' : tab);
const VIEWS = TABS.filter((x) => x !== 'inventory');

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
for (const id of ['work', 'truck', 'schedule', 'pdlg']) {
  $(id).addEventListener('close', () => {
    if (closingFromBack || history.state?.dialog !== id) return;
    ignorePop += 1;
    history.back();
  });
}
addEventListener('popstate', () => {
  if (ignorePop) { ignorePop -= 1; return; }
  const top = ['pdlg', 'work', 'truck', 'schedule'].map((id) => $(id)).find((d) => d.open);
  if (!top) return;
  closingFromBack = true;
  top.close();
  closingFromBack = false;
});

// ---- Roles: Mechanic, Inventory, Admin ------------------------------------------
// The switch at the top right. Mechanic is open; Inventory and Admin each
// have a password (any capitals). Not real security (anyone can read them
// here): it only keeps each person on their own pages. Each device remembers
// a password once it's typed, and the admin one opens Inventory too.
const ROLES = ['mechanic', 'inventory', 'admin'];
const ROLE_HOME = { mechanic: '#', inventory: '#inventory', admin: '#trucks' };
const ROLE_LOCKS = {
  inventory: { password: 'antonio', key: 'aslog.inventory' },
  admin: { password: 'Covington', key: 'aslog.admin' },
};
// The office's own password for aslog.dev/analytics; it opens that page only.
const ANALYTICS_LOCK = { password: 'andrea', key: 'aslog.analyticsPage' };
const remembered = (key) => { try { return localStorage.getItem(key) === 'yes'; } catch { return false; } };
const adminUnlocked = () => remembered(ROLE_LOCKS.admin.key);
const roleUnlocked = (role) => role === 'mechanic' || adminUnlocked() || (role === 'inventory' && remembered(ROLE_LOCKS.inventory.key))
  || (role === 'admin' && ANALYTICS_PAGE && remembered(ANALYTICS_LOCK.key));
const roleOfTab = (tab) => (tab === 'shop' ? 'mechanic' : tab === 'inventory' ? 'inventory' : 'admin');
// aslog.dev/analytics: the same app showing only Analytics (deploy-pages.yml
// copies index.html there), for a bookmark or a screen on the wall.
const ANALYTICS_PAGE = /\/analytics\/?$/.test(location.pathname);
const wantedTab = () => (ANALYTICS_PAGE ? 'analytics' : location.hash.slice(1));
let lockRole = null; // the role the password popup is for
let lastAllowedHash = ''; // where Cancel goes back to

function askPassword(role) {
  lockRole = role;
  const dlg = $('admin-lock');
  $('admin-lock-title').textContent = ANALYTICS_PAGE ? 'Analytics' : t('lockTitle', t('roles')[role]);
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
  const tab = wantedTab();
  if (!TABS.includes(tab)) return 'shop';
  // Locked: stay on the last page this device could open (behind the password box).
  return roleUnlocked(roleOfTab(tab)) ? tab : lastAllowedHash.slice(1) || 'shop';
}

// The role switch: three buttons on a wide screen, a menu on a phone.
function renderRoleSwitch() {
  const role = roleOfTab(currentTab());
  $('role-current').textContent = t('roles')[role];
  for (const b of document.querySelectorAll('#role-menu button')) {
    b.textContent = t('roles')[b.dataset.role];
    b.classList.toggle('active', b.dataset.role === role);
    b.setAttribute('aria-pressed', String(b.dataset.role === role));
  }
}
function pickRole(role) {
  $('role-switch').classList.remove('open');
  $('role-current').setAttribute('aria-expanded', 'false');
  if (role === roleOfTab(currentTab())) return;
  location.hash = ROLE_HOME[role];
}

function showTab() {
  const tab = currentTab();
  for (const x of VIEWS) $(`${x}-view`).hidden = x !== viewOf(tab);
  // Mechanic and Inventory: the shop look, EN/ES. Admin: English, admin tabs.
  const shop = roleOfTab(tab) !== 'admin';
  useEnglish(!shop);
  document.body.classList.toggle('shop-mode', shop);
  $('admin-nav').hidden = shop;
  $('lang').hidden = !shop;
  lastAllowedHash = tab === 'shop' ? '' : `#${tab}`;
  renderRoleSwitch();
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
    if (d.type === 'miles') return milesSetting(d, current[d.id], save);
    // Same layout as every other setting: label (and what it applies to), the
    // control (two equal buttons), then the help text.
    const row = el('div', 'setting-row');
    const label = el('div', 'setting-label', d.question ?? d.label);
    label.append(el('span', 'chip', d.appliesTo));
    const seg = el('div', 'choice-pair');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', d.question ?? d.label);
    const buttons = [true, false].map((value) => {
      const text = d.choices?.[value ? 'on' : 'off'] ?? (value ? 'Yes' : 'No');
      const b = el('button', current[d.id] === value ? 'active' : '', text);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(current[d.id] === value));
      return b;
    });
    buttons.forEach((b, i) => b.addEventListener('click', () => {
      const value = i === 0;
      if (current[d.id] === value) return;
      const text = d.choices?.[value ? 'on' : 'off'] ?? (value ? 'Yes' : 'No');
      if (confirm(`Change "${d.question ?? d.label}" to "${text}" for ALL trucks?`)) save(d, value, buttons);
    }));
    seg.append(...buttons);
    row.append(label, seg, el('p', 'setting-help', d.description));
    return row;
  }));
}

// A setting that's either the manufacturer's numbers or the shop's own, in
// thousands of miles (the oil change interval): two buttons, then the miles.
function milesSetting(d, value, save) {
  const row = el('div', 'setting-row');
  const label = el('div', 'setting-label', d.question ?? d.label);
  label.append(el('span', 'chip', d.appliesTo));
  const custom = Number(value) > 0;
  const seg = el('div', 'choice-pair');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', d.question ?? d.label);
  const [maker, own] = [d.choices?.on ?? 'Manufacturer', d.choices?.off ?? 'Custom'].map((text, i) => {
    const on = i === 1 ? custom : !custom;
    const b = el('button', on ? 'active' : '', text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(on));
    return b;
  });
  seg.append(maker, own);
  // Custom: every N thousand miles.
  const milesRow = el('div', 'miles-row');
  const input = Object.assign(el('input'), {
    type: 'number', inputMode: 'numeric', min: 5, max: 150, step: 1, value: custom ? Number(value) / 1000 : 30,
  });
  input.setAttribute('aria-label', `${d.question ?? d.label} (thousand miles)`);
  const apply = Object.assign(el('button', 'btn', 'Save'), { type: 'button' });
  milesRow.append(el('span', null, 'Every'), input, el('span', null, 'thousand miles'), apply);
  milesRow.hidden = !custom;
  input.addEventListener('input', () => input.setCustomValidity(''));
  maker.addEventListener('click', () => {
    if (!custom) return;
    if (confirm(`Use each manufacturer's oil change interval for ALL trucks again?`)) save(d, null, [maker, own, apply]);
  });
  own.addEventListener('click', () => {
    maker.classList.remove('active');
    own.classList.add('active');
    milesRow.hidden = false;
    input.focus();
  });
  apply.addEventListener('click', () => {
    const k = Number(input.value);
    if (!(k >= 5 && k <= 150)) {
      input.setCustomValidity('Thousands of miles, 5 to 150 (30 = every 30,000 mi)');
      input.reportValidity();
      return;
    }
    const miles = Math.round(k) * 1000;
    if (miles === Number(value)) return;
    if (confirm(`Change oil changes to every ${miles.toLocaleString('en-US')} mi for ALL trucks, in place of the manufacturer's interval?`)) save(d, miles, [maker, own, apply]);
  });
  row.append(label, seg, milesRow, el('p', 'setting-help', d.description));
  return row;
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
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers / no permission: copy through a hidden text box.
    const box = Object.assign(document.createElement('textarea'), { value: text });
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.append(box);
    box.select();
    document.execCommand('copy');
    box.remove();
  }
}

// A "Copy VIN" button that says "Copied ✓" for a moment.
function copyVinButton(vin, className = 'btn btn-ghost vin-copy') {
  const btn = el('button', className, t('copyVin'));
  btn.type = 'button';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await copyText(vin);
    btn.textContent = t('copiedVin');
    setTimeout(() => { btn.textContent = t('copyVin'); }, 2000);
  });
  return btn;
}

function vinRow(vin) {
  const row = el('div', 'vin-row');
  row.append(el('span', 'vin-text', `VIN ${vin}`), copyVinButton(vin));
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
  renderToday();
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

// "Done today" at the bottom of the shop list: the work recorded today, newest
// first, so mechanics see it counted and nobody records the same job twice.
function renderToday() {
  const box = $('shop-today');
  const now = new Date();
  const today = now.toLocaleDateString('en-CA');
  const isToday = (e) => (e.loggedAtMs ? new Date(e.loggedAtMs).toLocaleDateString('en-CA') === today : e.source === 'app' && e.date === today);
  const done = serviceLog.filter((e) => e.type !== 'duty' && isToday(e))
    .sort((a, b) => (b.loggedAtMs || Infinity) - (a.loggedAtMs || Infinity));
  box.hidden = !done.length;
  if (!done.length) { box.replaceChildren(); return; }
  box.replaceChildren(el('h3', 'shop-group today-title', t('doneToday', done.length)), ...done.map((e) => {
    const row = el('button', 'today-row');
    row.type = 'button';
    const time = e.loggedAtMs ? new Date(e.loggedAtMs).toLocaleTimeString(getLang() === 'es' ? 'es-MX' : 'en-US', { hour: 'numeric', minute: '2-digit' }) : '…';
    const what = el('span', 'today-what', e.type === 'repair' ? `${t('repair')}: ${e.itemName ?? ''}` : e.itemName ?? '');
    row.append(el('span', 'today-unit', e.vehicleName ?? ''), what, el('span', 'today-meta', [time, e.loggedBy].filter(Boolean).join(' · ')));
    row.addEventListener('click', () => {
      if (e.assetType === 'trailer') openTrailer(e.vehicleId);
      else if (vehicles.some((v) => v.id === e.vehicleId)) openTruck(e.vehicleId);
    });
    return row;
  }));
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
  // 4. Tires and batteries.
  body.append(truckTiresSection(v), batterySection(v));
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

// What's next after a save, worked out as if the new visit were already in
// the log: the soonest of the items just done, or, for tires only, when the
// new tires reach their limit. Shown in the "Saved" bar.
function nextAfterSave(v, keys, miles, date, tires = []) {
  if (keys.length) {
    const visits = [...(visitsByTruck.get(v.id) ?? []), { date, miles, services: keys }];
    const last = lastDoneFrom(visits, records[v.id]?.items);
    const rows = truckMaintenance({ ...v, odometerMiles: Math.max(v.odometerMiles ?? 0, miles) }, schedules, last, new Date(), settings(), dutyModels(), dutyDocs[v.id])
      .filter((r) => keys.includes(r.key) && (r.dueMiles != null || r.dueDate));
    const soonest = rows.sort((a, b) => (a.urgency ?? Infinity) - (b.urgency ?? Infinity))[0];
    if (soonest) {
      const when = [soonest.dueMiles != null && `${fmt.format(soonest.dueMiles)} mi`, soonest.dueDate && dateText(soonest.dueDate)].filter(Boolean).join(t('or'));
      return t('nextDue', shownName(soonest.item.name), when);
    }
  }
  if (tires.length) {
    const limits = truckTireLimits();
    const first = Math.min(...tires.map((p) => limitFor(p, limits)));
    return t('nextTires', fmt.format(miles + first));
  }
  return '';
}

function openWork(vehicleId, { keys = [] } = {}) {
  work = {
    vehicleId, jobs: new Set(), extra: new Set(keys), unticked: new Set(), days: null,
    tires: new Set(), brands: {}, batteryCount: null, parts: new Set(keys.length ? ['service'] : []), shelf: {},
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
  const batteryBox = el('div', 'work-batteries');
  const shelfBox = el('div', 'work-shelf');
  const PARTS = [['service', 'partService', 'partServiceHint'], ['tires', 'partTires', 'partTiresHint'],
    ['batteries', 'partBatteries', 'partBatteriesHint'], ['repair', 'partRepair', 'partRepairHint']];
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
    batteryBox.hidden = !on('batteries');
    repairBox.hidden = !on('repair');
  }

  // Parts from the shelf: what the picked work uses, from the service kits
  // (oil, filters) and the tire / battery parts. Each can be changed; it's
  // saved on the work entry, which is what takes it off the stock count.
  function shelfUse() {
    const tags = on('service') ? [...new Set([...tagsForJobs([...work.jobs]), ...tagsForKeys(workKeys(v))])] : [];
    const groups = {
      service: kitParts(v, tags, kits, schedules).parts,
      tires: on('tires') ? tireParts(TRUCK_TIRE_POSITIONS.filter((p) => work.tires.has(p)), partsList) : {},
      batteries: on('batteries') ? batteryParts(work.batteryCount, partsList) : {},
    };
    for (const g of Object.values(groups)) for (const id of Object.keys(g)) if (work.shelf[id] != null) g[id] = work.shelf[id];
    return groups;
  }
  function drawShelf() {
    const used = Object.entries(Object.assign({}, ...Object.values(shelfUse())));
    shelfBox.hidden = !used.length;
    if (!used.length) { shelfBox.replaceChildren(); return; }
    const rows = used.map(([id, qty]) => {
      const part = partById(id);
      const row = el('div', 'shelf-row');
      const minus = Object.assign(el('button', 'shelf-step', '−'), { type: 'button' });
      const plus = Object.assign(el('button', 'shelf-step', '+'), { type: 'button' });
      minus.setAttribute('aria-label', `− ${part?.name ?? ''}`);
      plus.setAttribute('aria-label', `+ ${part?.name ?? ''}`);
      const step = (d) => { work.shelf[id] = Math.max(0, Math.round((qty + d) * 100) / 100); drawShelf(); };
      minus.addEventListener('click', () => step(-1));
      plus.addEventListener('click', () => step(1));
      const left = part ? onHand(part, receipts, serviceLog) - qty : null;
      const name = el('span', 'shelf-name', part?.name ?? id);
      const meta = el('span', 'shelf-meta', [part?.number, left != null && part?.countAt ? t('shelfLeft', amountText(part, left)) : null].filter(Boolean).join(' · '));
      row.append(name, meta, minus, el('span', `shelf-qty${qty ? '' : ' zero'}`, amountText(part, qty)), plus);
      return row;
    });
    shelfBox.replaceChildren(el('div', 'section-title', t('fromShelf')), el('p', 'muted', t('fromShelfHint')), ...rows);
  }
  const shelfFor = (group) => Object.fromEntries(Object.entries(shelfUse()[group]).filter(([, q]) => q > 0));

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
    const n = (on('service') ? keys.length : 0) + (on('repair') ? 1 : 0) + (on('tires') ? work.tires.size : 0) + (on('batteries') ? 1 : 0);
    save.textContent = n ? t('saveCount', n, v.name) : t('save');
    drawShelf();
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
      brandFields(TRUCK_TIRE_POSITIONS.filter((p) => work.tires.has(p)), truckPositionName, work.brands),
    );
  }

  // Batteries: replaced, and how many (optional; tap again to clear).
  function drawBatteries() {
    const chips = el('div', 'battery-count');
    for (const n of [1, 2, 3, 4]) {
      const b = Object.assign(el('button', `count-chip${work.batteryCount === n ? ' on' : ''}`, String(n)), { type: 'button' });
      b.setAttribute('aria-pressed', String(work.batteryCount === n));
      b.addEventListener('click', () => { work.batteryCount = work.batteryCount === n ? null : n; drawBatteries(); drawShelf(); });
      chips.append(b);
    }
    batteryBox.replaceChildren(el('div', 'section-title', t('batteriesTitle')), el('p', 'muted', t('howManyBatteries')), chips);
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
  const who = loggedByField();

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
  details.append(wide(field(t('note'), note)), who.wrap);

  const error = el('p', 'form-error');
  error.hidden = true;
  const cancel = Object.assign(el('button', 'btn btn-ghost btn-cancel', t('cancel')), { type: 'button' });
  cancel.addEventListener('click', () => $('work').close());
  const faultBox = faultsBox(v, { showMinor: false });
  // Save stays at the bottom of the screen while scrolling.
  const actions = el('div', 'work-actions');
  actions.append(error, save, cancel);
  form.append(...(faultBox ? [faultBox] : []), parts, serviceBox, tireBox, batteryBox, repairBox, shelfBox, details, actions);
  body.append(form);
  drawParts();
  showParts();
  drawTires();
  drawBatteries();
  refresh();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fail = (msg) => { error.textContent = msg; error.hidden = false; error.scrollIntoView({ block: 'nearest' }); };
    // Only the picked parts are saved (a part tapped off keeps its ticks hidden, not saved).
    const service = on('service');
    const keys = service ? workKeys(v) : [];
    const jobsDone = service ? work.jobs.size : 0;
    const doRepair = on('repair');
    const doBatteries = on('batteries');
    const tires = on('tires') ? TRUCK_TIRE_POSITIONS.filter((p) => work.tires.has(p)) : [];
    const m = Number(miles.value);
    const repair = repairText.value.trim();
    // Catch typos before they're saved.
    if (!keys.length && !jobsDone && !doRepair && !tires.length && !doBatteries) return fail(t('errTick'));
    if (doRepair && !repair) return fail(t('errRepair'));
    if (missingBrands(tires, work.brands).length) {
      tireBox.querySelector(`input[data-pos="${missingBrands(tires, work.brands)[0]}"]`)?.focus();
      return fail(t('errBrand'));
    }
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
    const loggedBy = who.value();
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
      batch.set(ref, { ...common, services: keys, itemName: workSummary(v, keys), partsUsed: shelfFor('service') });
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
        tireBrands: savedTireBrands(order, work.brands), partsUsed: shelfFor('tires'),
        itemName: `Tires replaced: ${withBrands(order, truckPositionName, savedTireBrands(order, work.brands))}`,
      });
      refs.push(ref);
    }
    if (doBatteries) {
      const ref = doc(collection(db, 'serviceLog'));
      const n = work.batteryCount ?? null;
      batch.set(ref, {
        ...common, type: 'batteries', services: [], batteries: n, partsUsed: shelfFor('batteries'),
        itemName: n ? `Batteries replaced (${n})` : 'Batteries replaced',
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
        tires.length ? t('tiresSection').toLowerCase() : null, doBatteries ? t('batteriesWord') : null].filter(Boolean).join(' + ');
      const next = nextAfterSave(v, keys, m, date.value, tires);
      $('work').close();
      const matching = startMatchingSoon();
      showUndo([t('saved', v.name, summary), next].filter(Boolean).join(' · '), async () => {
        matching.cancel();
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

// ---- Parts: the buyer's page ---------------------------------------------------
// Tabs: Receipts, To buy (what upcoming work needs minus what's on the
// shelf), To check (receipts the reader wasn't sure of), Matches (admin:
// which repair each bought part went into) and Stock (admin: every part,
// its count, and the service kits). The buyer opens it at aslog.dev/#inventory;
// admin has it as a tab too.

const PART_GROUPS = ['oil', 'filter', 'tire', 'battery', 'fluid', 'other'];
const PARTS_SIDES = ['receipts', 'buy', 'review', 'stock'];
const PARTS_SIDE_KEY = 'aslog.partsSide';
let partsSide = (() => {
  try {
    const s = localStorage.getItem(PARTS_SIDE_KEY);
    if (s === 'check' || s === 'matches') return 'review'; // the tabs Review replaced
    return PARTS_SIDES.includes(s) ? s : 'receipts';
  } catch { return 'receipts'; }
})();
let showAllWork = false; // To buy: the upcoming work behind the list, folded
let showKits = false; // Stock: the service kits, folded by default

const activeParts = () => partsList.filter((p) => !p.archived)
  .sort((a, b) => PART_GROUPS.indexOf(a.group) - PART_GROUPS.indexOf(b.group) || String(a.name).localeCompare(String(b.name)));
const partById = (id) => partsList.find((p) => p.id === id);
const qtyText = (n) => fmt.format(Math.round(n * 100) / 100);
// "11 gal" for oil, "2" for filters.
const amountText = (part, n) => (part?.unit === 'gal' ? `${qtyText(n)} gal` : qtyText(n));
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const stockNow = () => Object.fromEntries(partsList.map((p) => [p.id, onHand(p, receipts, serviceLog)]));

// Upcoming work across the fleet: services due soon or overdue, worn tires.
function fleetWork() {
  const trucks = vehicles.map(withMaintenance).filter((v) => !v.shop);
  const trailerRows = trailerList().map(({ c, worn }) => ({ id: c.id, name: c.name, worn }));
  return upcomingWork(trucks, trailerRows, kits, schedules, partsList)
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'overdue' ? -1 : 1)
      || String(a.unitName).localeCompare(String(b.unitName), undefined, { numeric: true }));
}

// VINs (trucks only: Samsara has none for the trailers).
const unitVin = (id, trailer) => (trailer ? null : vehicles.find((v) => v.id === id)?.vin || null);

// "Oil filter · DD15 Gen 5" -> "Oil filter": the VIN tells the counter which one.
const shortPartName = (part) => String(part.name ?? '').split(' · ')[0];
const packsText = (packs) => packs.map((p) => `${p.count} ${p.name.toLowerCase()}${p.count === 1 ? '' : 's'}`).join(` ${t('or')} `);

// "Fuel filter kit", or "2 × Steer tire". Lines with no truck (keep on the
// shelf, oil) have no VIN, so they use the full name ("Oil filter · DD15 Gen 5").
const lineWhat = (x) => `${x.kind !== 'bulk' && x.qty !== 1 ? `${qtyText(x.qty)} × ` : ''}${x.kind === 'unit' ? shortPartName(x.part) : x.part.name}`;

// One shopping list line as text: "Fuel filter kit for VIN 3AKJ…".
function shoppingLineText(x) {
  const what = lineWhat(x);
  if (x.kind === 'bulk') return `${what}: ${amountText(x.part, x.qty)}${x.packs.length ? ` (${packsText(x.packs)})` : ''}`;
  if (x.kind === 'restock') return t('keepOnShelf', what);
  const vin = unitVin(x.unitId, x.trailer);
  return vin ? t('lineForVin', what, vin) : t('lineForUnit', what, x.trailer ? `${t('trailer')} ${x.unitName}` : x.unitName);
}

function setPartsSide(side) {
  partsSide = PARTS_SIDES.includes(side) ? side : 'receipts';
  try { localStorage.setItem(PARTS_SIDE_KEY, partsSide); } catch { /* not remembered */ }
  renderParts();
  window.scrollTo(0, 0);
}

function renderParts() {
  if (viewOf(currentTab()) !== 'parts') return;
  for (const b of document.querySelectorAll('#lang button')) b.classList.toggle('active', b.dataset.lang === getLang());
  const stock = stockNow();
  const work = fleetWork();
  const list = shoppingList(partsList, work, stock);
  const queue = matchQueue();
  const counts = {
    buy: list.length, stock: activeParts().length, receipts: receipts.length,
    review: toCheck().length + queue.doubts.length + queue.noWork.length + queue.noParts.length,
  };
  // The buyer's job is the list and sending the receipts; checking what the
  // AI read and matched, the shelf count and the kits are admin's
  // (Admin → Parts).
  const buyer = roleOfTab(currentTab()) === 'inventory';
  const adminOnly = ['review', 'stock'];
  if (buyer && adminOnly.includes(partsSide)) partsSide = 'buy';
  const tabs = document.querySelectorAll('#parts-side button');
  $('parts-side').classList.toggle('many', !buyer);
  for (const b of tabs) {
    b.hidden = buyer && adminOnly.includes(b.dataset.side);
    const on = b.dataset.side === partsSide;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.querySelector('.side-name').textContent = t(`partsSide_${b.dataset.side}`);
    b.querySelector('.side-count').textContent = counts[b.dataset.side] || '';
  }
  const body = $('parts-body');
  if (partsSide === 'stock') body.replaceChildren(...partsStock(stock));
  else if (partsSide === 'receipts') body.replaceChildren(...partsReceipts());
  else if (partsSide === 'review') body.replaceChildren(...partsReview(queue));
  else body.replaceChildren(...partsBuy(list, work, stock));
}

// To buy: the shopping list, then the work it's for.
function partsBuy(list, work, stock) {
  const out = [el('h2', 'parts-title', t('toBuyTitle')), el('p', 'parts-intro', t('toBuyIntro'))];
  if (!activeParts().length) {
    out.push(el('p', 'parts-empty', t('noPartsYet')));
    return out;
  }
  if (!list.length) out.push(el('p', 'parts-empty parts-good', t('nothingToBuy')));
  // One line per part per truck: "Fuel filter kit for VIN …", the VIN in
  // large type to read out at the parts counter. Bought parts come off the
  // list once their receipt is uploaded and read.
  const lines = el('div', 'buy-lines');
  for (const x of list) {
    const row = el('div', `buy-line line-${x.kind}`);
    const vin = x.kind === 'unit' ? unitVin(x.unitId, x.trailer) : null;
    const text = el('span', 'buy-text');
    if (vin) {
      const vinLine = el('span', 'buy-vin', vin);
      vinLine.append(el('span', 'buy-unit', ` · ${x.unitName}`));
      text.append(el('strong', null, lineWhat(x)), ` ${t('forVin')}`, vinLine);
    } else text.append(el('strong', null, shoppingLineText(x)));
    row.append(text);
    lines.append(row);
  }
  if (list.length) out.push(lines);
  if (list.length) {
    const copy = Object.assign(el('button', 'btn parts-copy', t('copyList')), { type: 'button' });
    copy.addEventListener('click', async () => {
      const text = [t('toBuyTitle'), ...list.map(shoppingLineText)].join('\n');
      try {
        if (navigator.share) await navigator.share({ text });
        else { await navigator.clipboard.writeText(text); copy.textContent = t('copied'); setTimeout(() => { copy.textContent = t('copyList'); }, 2000); }
      } catch { /* closed the share sheet */ }
    });
    out.push(copy);
  }

  // The work behind the list: one line per truck (or trailer).
  const head = el('button', `shop-group section-toggle parts-work-head${showAllWork ? ' open' : ''}`);
  head.type = 'button';
  head.setAttribute('aria-expanded', String(showAllWork));
  head.append(el('span', 'section-label', t('upcomingWork')), el('span', 'section-count', String(work.length)), el('span', 'section-chevron', showAllWork ? '▾' : '▸'));
  head.addEventListener('click', () => { showAllWork = !showAllWork; renderParts(); });
  out.push(head);
  if (showAllWork) {
    if (!work.length) out.push(el('p', 'muted', t('noUpcoming')));
    for (const w of work) {
      const row = el('div', `work-need need-${w.status}`);
      const what = w.what === 'tires'
        ? t('needTires', w.tires.length)
        : w.tags.map((tag) => t('kitTags')[tag] ?? tag).join(' + ');
      row.append(el('span', 'need-unit', w.unitName), el('span', 'need-what', `${what} · ${t(w.status)}`));
      const vin = unitVin(w.unitId, w.trailer);
      if (vin) row.append(el('span', 'need-vin vin-text', `VIN ${vin}`));
      const used = Object.entries(w.parts).map(([id, qty]) => `${amountText(partById(id), qty)} ${partById(id)?.name ?? id}`);
      if (used.length) row.append(el('span', 'need-parts', used.join(' · ')));
      if (w.missing.length) row.append(el('span', 'need-missing', t('kitMissing', w.missing.map((tag) => t('kitTags')[tag] ?? tag).join(', '))));
      if (w.what === 'tires' && !used.length) row.append(el('span', 'need-missing', t('tirePartMissing')));
      out.push(row);
    }
  }
  return out;
}

// Stock: every part with what's on the shelf, then the service kits.
function partsStock(stock) {
  const add = Object.assign(el('button', 'btn parts-add', t('addPart')), { type: 'button' });
  add.addEventListener('click', () => openPart(null));
  const out = [el('h2', 'parts-title', t('stockTitle')), el('p', 'parts-intro', t('stockIntro')), add];
  for (const [group, list] of Map.groupBy(activeParts(), (p) => p.group ?? 'other')) {
    out.push(el('h3', 'shop-group parts-group', t('partGroups')[group] ?? group));
    for (const p of list) {
      const have = stock[p.id] ?? 0;
      const low = p.min != null && p.min !== '' && have < Number(p.min);
      const row = el('button', `stock-row${low ? ' low' : ''}${have < 0 ? ' negative' : ''}`);
      row.type = 'button';
      row.append(
        el('span', 'stock-name', p.name),
        el('span', 'stock-qty', amountText(p, have)),
        el('span', 'stock-meta', [p.number, p.min ? t('keepMin', amountText(p, Number(p.min))) : null, p.countAt ? null : t('notCounted')].filter(Boolean).join(' · ')),
      );
      row.addEventListener('click', () => openPart(p.id));
      out.push(row);
    }
  }
  out.push(...kitCards());
  return out;
}

// What each service uses, per engine (oil, fuel filters) and per truck model
// (air filter, air dryer): one card per kit, with the trucks it covers.
function kitGroups() {
  const groups = new Map();
  for (const v of vehicles) {
    for (const tag of ['oil', 'airFilter']) {
      const key = kitKey(v, tag, schedules);
      if (!key) continue;
      const g = groups.get(key) ?? { key, category: kitCategory(tag), trucks: [] };
      g.trucks.push(v);
      groups.set(key, g);
    }
  }
  for (const g of groups.values()) {
    g.label = schedules.get(g.key)?.name ?? g.key;
    g.trucks.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  }
  return [...groups.values()];
}

function kitCards() {
  const groups = kitGroups();
  const unset = groups.reduce((n, g) => n + KIT_TAGS.filter((tag) => kitCategory(tag) === g.category && !kits[g.key]?.[tag]?.length).length, 0);
  const head = el('button', `shop-group section-toggle kits-head${showKits ? ' open' : ''}`);
  head.type = 'button';
  head.setAttribute('aria-expanded', String(showKits));
  head.append(el('span', 'section-label', t('kitsTitle')), el('span', 'section-count', String(groups.length)), el('span', 'section-chevron', showKits ? '▾' : '▸'));
  head.addEventListener('click', () => { showKits = !showKits; renderParts(); });
  const out = [head, el('p', 'parts-intro', [t('kitsIntro'), unset ? t('kitsUnset', unset) : null].filter(Boolean).join(' '))];
  if (!showKits) return out;
  for (const category of ['engine', 'chassis']) {
    for (const g of groups.filter((x) => x.category === category).sort((a, b) => b.trucks.length - a.trucks.length)) {
      const card = el('section', 'kit-card');
      card.append(el('h3', 'kit-name', g.label), el('p', 'kit-trucks', `${t('kitTrucks', g.trucks.length)}: ${g.trucks.map((v) => v.name).join(', ')}`));
      for (const tag of KIT_TAGS.filter((x) => kitCategory(x) === category)) {
        const lines = kits[g.key]?.[tag] ?? [];
        const row = el('button', `kit-row${lines.length ? '' : ' empty'}`);
        row.type = 'button';
        row.append(
          el('span', 'kit-tag', t('kitTags')[tag]),
          el('span', 'kit-parts', lines.length ? lines.map((l) => `${amountText(partById(l.part), l.qty)} ${partById(l.part)?.name ?? '?'}`).join(' · ') : t('kitEmpty')),
          el('span', 'kit-edit', t('edit')),
        );
        row.addEventListener('click', () => openKit(g.key, tag, g.label));
        card.append(row);
      }
      out.push(card);
    }
  }
  return out;
}

// Receipts: one button to upload photos (each becomes a receipt that the
// "Read receipts" GitHub Action fills in), then the history, newest first,
// each with its photo.
function partsReceipts() {
  const admin = roleOfTab(currentTab()) === 'admin';
  const picker = Object.assign(el('input'), { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const upload = Object.assign(el('button', 'btn parts-add upload-receipts', t('uploadReceipts')), { type: 'button' });
  upload.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    const files = [...(picker.files ?? [])];
    if (!files.length) return;
    upload.disabled = true;
    upload.textContent = t('uploading', files.length);
    try {
      await uploadReceipts(files);
      showUndo(t('uploaded', files.length), null);
    } catch (err) {
      showAppError(t('couldNotSave', err.message));
    } finally {
      upload.disabled = false;
      upload.textContent = t('uploadReceipts');
      picker.value = '';
    }
  });
  const out = [el('h2', 'parts-title', t('receiptsTitle')), el('p', 'parts-intro', t('receiptsIntro')), upload, picker];
  // Newest upload first, so a receipt just uploaded is always on top.
  const all = [...receipts].sort((a, b) => b.createdMs - a.createdMs || (b.date ?? '').localeCompare(a.date ?? ''))
    .map((r) => ({ r, match: receiptMatch(r, itemUses) }));
  if (!all.length) out.push(el('p', 'parts-empty', t('noReceipts')));
  // Admin can narrow the list: needs a look, not matched yet, matched.
  const inFilter = (x, f) => f === 'all' || (f === 'review' ? ['review', 'unreadable', 'error'].includes(x.match.state)
    : f === 'open' ? ['waiting', 'read'].includes(x.match.state) : x.match.state === 'matched');
  if (admin && all.length) {
    const bar = el('div', 'receipt-filter');
    bar.setAttribute('role', 'tablist');
    for (const f of RECEIPT_FILTERS) {
      const b = el('button', receiptFilter === f ? 'active' : '');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(receiptFilter === f));
      b.append(el('span', null, t('receiptFilter')[f]), el('span', 'receipt-filter-count', String(all.filter((x) => inFilter(x, f)).length)));
      b.addEventListener('click', () => { receiptFilter = f; renderParts(); });
      bar.append(b);
    }
    out.push(bar);
  }
  const list = admin ? all.filter((x) => inFilter(x, receiptFilter)) : all;
  if (all.length && !list.length) out.push(el('p', 'parts-empty', t('noReceiptsHere')));
  for (const { r, match } of list) {
    const status = !admin && match.state === 'review' ? (match.open.length ? 'read' : 'matched') : match.state;
    const card = el('div', `receipt-card status-${status}`);
    const row = el('button', 'receipt-row');
    row.type = 'button';
    row.append(
      el('span', 'receipt-vendor', r.vendor || t('noVendor')),
      el('span', 'receipt-total', r.total != null ? money(r.total) : ''),
      el('span', 'receipt-status', status === 'read' ? t('readOf', match.placed, match.total) : t('receiptStatus')[status] ?? status),
      el('span', 'receipt-meta', receiptMeta(r, r.lines?.length ? t('lineCount', r.lines.length) : null)),
    );
    // Admin fixes and sorts lines; the buyer sees what was read.
    row.addEventListener('click', () => (admin ? openReceipt(r.id) : viewReceipt(r.id)));
    card.append(row);
    if (r.hasPhoto) {
      const photo = Object.assign(el('button', 'receipt-photo-link', t('seePhoto')), { type: 'button' });
      photo.addEventListener('click', () => showReceiptPhoto(r));
      card.append(photo);
    }
    out.push(card);
  }
  return out;
}

// In the history the buyer sees a receipt as read once it's read; the lines
// that still need placing are admin's (Review tab).
const shownStatus = (r, admin) => (!admin && r.status === 'review' ? 'read' : r.status ?? 'read');
const RECEIPT_FILTERS = ['all', 'review', 'open', 'matched'];
let receiptFilter = 'all';

// The lines of a receipt not tied to work yet, and why.
function openLinesBox(r) {
  const { open } = receiptMatch(r, itemUses);
  if (!open.length || ['waiting', 'unreadable', 'error'].includes(r.status)) return [];
  const box = el('div', 'open-lines');
  box.append(el('div', 'open-lines-title', `${t('openLinesTitle')} · ${open.length}`));
  for (const x of open) {
    const row = el('div', `open-line open-${x.why}`);
    row.append(el('strong', null, x.text || t('receipt')), el('span', null, t('openWhy')[x.why]));
    box.append(row);
  }
  return [box];
}

// Receipts with lines the reader couldn't place (or whose math is off).
const toCheck = () => receipts.filter((r) => r.status === 'review').sort((a, b) => b.createdMs - a.createdMs);

// Receipts to check: the ones the reader wasn't sure of, each opening the
// receipt form (what was read, the best guess, pick where each line goes).
function receiptsToCheck() {
  const out = [];
  for (const r of toCheck()) {
    const open = (r.lines ?? []).filter((l) => !linePlaced(l)).length;
    const card = el('div', 'receipt-card status-review');
    const row = el('button', 'receipt-row');
    row.type = 'button';
    row.append(
      el('span', 'receipt-vendor', r.vendor || t('noVendor')),
      el('span', 'receipt-total', r.total != null ? money(r.total) : ''),
      el('span', 'receipt-status', open ? t('linesToPlace', open) : t('checkTotal')),
      el('span', 'receipt-meta', receiptMeta(r)),
    );
    row.addEventListener('click', () => openReceipt(r.id));
    card.append(row);
    out.push(card);
  }
  return out;
}

// Each photo becomes a receipt "waiting to be read".
async function uploadReceipts(files) {
  const today = new Date().toLocaleDateString('en-CA');
  for (const file of files) {
    const photo = await shrinkPhoto(file);
    const ref = doc(collection(db, 'receipts'));
    const batch = writeBatch(db);
    batch.set(ref, {
      id: ref.id, status: 'waiting', date: today, vendor: '', lines: [], tax: null, total: null,
      hasPhoto: true, uploadedBy: rememberedName() || null, createdAt: serverTimestamp(),
    });
    batch.set(doc(db, 'receiptPhotos', ref.id), { data: photo });
    await batch.commit();
  }
}

// The receipt photo, full width in a popup (pinch to zoom on a phone). With
// `context`, a line above it saying what this cost took from the receipt.
async function showReceiptPhoto(r, { context = null } = {}) {
  const body = partsDialog(r.vendor || t('receipt'), [dateText(r.date), r.total != null ? money(r.total) : null].filter(Boolean).join(' · '));
  const top = [];
  if (context) top.push(el('p', 'receipt-context', context));
  const details = Object.assign(el('button', 'link-btn', 'Receipt details'), { type: 'button' });
  details.addEventListener('click', () => openReceipt(r.id));
  top.push(details);
  if (!r.hasPhoto) { body.replaceChildren(...top, el('p', 'muted', t('noPhoto'))); return; }
  body.replaceChildren(...top, el('p', 'muted', t('loadingPhoto')));
  const snap = await getDoc(doc(db, 'receiptPhotos', r.id));
  const img = Object.assign(el('img', 'receipt-full'), { alt: t('receipt') });
  body.replaceChildren(...top, snap.exists() ? Object.assign(img, { src: snap.data().data }) : el('p', 'muted', t('noPhoto')));
}

// A small button naming a receipt ("FleetPride · Nov 3") that opens its photo.
const RECEIPT_ICON = '<svg viewBox="0 0 13 15" width="12" height="14" aria-hidden="true"><path d="M1 1h11v13l-2-1.3L8.3 14 6.5 12.7 4.7 14 3 12.7 1 14z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 4.5h6M3.5 7h6M3.5 9.5h4" stroke="currentColor" stroke-width="1.3"/></svg>';
function receiptChip(receiptId, context) {
  const r = receipts.find((x) => x.id === receiptId);
  const b = el('button', 'rc-chip');
  b.type = 'button';
  if (!r) { b.disabled = true; b.textContent = 'Receipt removed'; return b; }
  b.innerHTML = RECEIPT_ICON;
  b.append(document.createTextNode([r.vendor ? r.vendor.split(/[,(]/)[0].trim().slice(0, 24) : t('receipt'), r.date ? niceDate(r.date).replace(/, \d{4}$/, '') : null].filter(Boolean).join(' · ')));
  b.setAttribute('aria-label', `See receipt: ${r.vendor || t('receipt')}, ${dateText(r.date)}`);
  b.addEventListener('click', () => showReceiptPhoto(r, { context }));
  return b;
}

// The buyer's view of a receipt: what was read from it, and the photo.
// How a receipt came in: WhatsApp, a text, the app, or typed by hand.
const receiptSource = (r) => r.source ?? (r.hasPhoto ? 'app' : 'typed');
const isRead = (r) => r.status !== 'waiting' && r.status !== 'unreadable' && r.status !== 'error';

// "receipt Oct 20, 2026 · sent Oct 27, 2026, 11:37 PM · 1 line · Tony"
function receiptMeta(r, extra = null) {
  return [
    isRead(r) && r.date ? t('receiptShort', [dateText(r.date), clockText(r.time)].filter(Boolean).join(' ')) : null,
    r.createdMs ? t('sentShort', dateTimeText(r.createdMs)) : null,
    extra, r.uploadedBy ?? r.boughtBy,
  ].filter(Boolean).join(' · ');
}

// The receipt's three dates: when it was sent, the date printed on it, and
// when the work its parts went into was done.
function receiptDates(r) {
  const box = el('dl', 'receipt-dates');
  const row = (label, ...values) => {
    const dd = el('dd');
    for (const v of values) dd.append(typeof v === 'string' ? el('span', null, v) : v);
    box.append(el('dt', null, label), dd);
  };
  row(t('datesSent'), [r.createdMs ? dateTimeText(r.createdMs) : '—', t('sentVia')[receiptSource(r)], r.uploadedBy ?? r.boughtBy].filter(Boolean).join(' · '));
  row(t('datesReceipt'), isRead(r) && r.date ? [dateText(r.date), clockText(r.time)].filter(Boolean).join(' ') : t('notReadYet'));
  const work = receiptWork(r, itemUses, serviceLog);
  if (work.length) {
    row(t('datesWork'), ...work.map((w) => `${dateText(w.date)} · ${w.vehicleName ?? unitName(w.vehicleId)} · ${w.text}${w.sure ? '' : ` (${t('maybeWork')})`}`));
  } else if (isRead(r)) {
    const allShelf = (r.lines ?? []).length && (r.lines ?? []).every((l) => l.part);
    row(t('datesWork'), allShelf ? t('shelfOnly') : t('noWorkYet'));
  }
  return box;
}

function viewReceipt(id) {
  const r = receipts.find((x) => x.id === id);
  if (!r) return;
  const status = shownStatus(r, false);
  const match = receiptMatch(r, itemUses);
  const shown = status === 'read' ? (match.open.length ? t('readOf', match.placed, match.total) : t('receiptStatus').matched) : t('receiptStatus')[status];
  const body = partsDialog(r.vendor || t('receipt'), [dateText(r.date), shown].filter(Boolean).join(' · '));
  if (r.note) body.append(el('p', 'receipt-note', t('buyerNote', r.note)));
  body.append(receiptDates(r), ...openLinesBox(r));
  if (status === 'waiting') body.append(el('p', 'parts-hint', t('waitingHint')));
  if (status === 'unreadable' || status === 'error') body.append(el('p', 'need-missing', `${t('unreadableHint')} ${(r.problems ?? []).concat(r.readError ?? []).join(' ')}`));
  const lines = el('div', 'buy-lines receipt-view');
  for (const l of r.lines ?? []) {
    const row = el('div', 'buy-line');
    const name = l.part ? partById(l.part)?.name ?? l.text : l.text;
    const truck = l.to === 'truck' ? vehicles.find((v) => v.id === l.vehicleId)?.name : l.for?.map((u) => u.name).join(', ');
    row.append(el('span', 'buy-text', `${qtyText(l.qty)} × ${name}${truck ? ` · ${truck}` : ''}`), el('strong', null, l.price != null ? money(l.price) : ''));
    lines.append(row);
  }
  if (r.lines?.length) body.append(lines);
  if (r.tax != null && r.lines?.length) body.append(el('p', 'receipt-tax', `${t('taxWord')} ${money(r.tax)}`));
  for (const f of r.fees ?? []) body.append(el('p', 'receipt-tax', `${f.label} ${money(f.amount)}`));
  if (r.total != null) body.append(el('div', 'receipt-sum', t('receiptTotal', money(r.total))));
  if (r.hasPhoto) {
    const photo = Object.assign(el('button', 'btn parts-copy', t('seePhoto')), { type: 'button' });
    photo.addEventListener('click', () => showReceiptPhoto(r));
    body.append(photo);
  }
  // A photo that couldn't be read can be thrown away and uploaded again.
  if (status === 'unreadable' || status === 'error') {
    const del = Object.assign(el('button', 'btn btn-ghost btn-delete', t('deleteReceipt')), { type: 'button' });
    del.addEventListener('click', async () => {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'receipts', r.id));
      batch.delete(doc(db, 'receiptPhotos', r.id));
      await batch.commit();
      $('pdlg').close();
    });
    body.append(del);
  }
}

// ---- Matches: which repair each bought part went into (admin) -------------------
// The matcher (scripts/match-items.mjs) ties the repair parts, labor and
// cores from the receipts to the repairs in the work log. Admin checks the
// ones it wasn't sure of, spot-checks the rest, and sorts out parts no work
// explains and repairs with no parts. Every change is saved in the
// corrections collection, which the AI reads before its next run.

const todayIso = () => new Date().toLocaleDateString('en-CA');
const matchQueue = () => auditQueue({ items: receiptItems(receipts), uses: itemUses, log: serviceLog, today: todayIso() });
const unitName = (id) => vehicles.find((v) => v.id === id)?.name ?? trailers.find((c) => c.id === id)?.name ?? id;
const SPEND_PERIODS = ['month', 'd90', 'year'];
let spendPeriod = 'month';
let showRecent = false; // Matches: the AI's own matches of the last 2 weeks, folded

// A repair in one line: "T-07 · Oct 19 · Disco delantero copiloto".
const repairLine = (e) => [e.vehicleName ?? unitName(e.vehicleId), dateText(e.date), repairText(e)].filter(Boolean).join(' · ');
const itemLine = (item, qty) => `${qtyText(qty ?? item.qty)} × ${item.text || t('receipt')}`;
const receiptOf = (item) => receipts.find((r) => r.id === item.receiptId);

// Review (admin): what the AI read and matched that needs a person —
// receipts it wasn't sure of, matches it wasn't sure of, parts no work
// explains, repairs with no parts — then where the money went and the notes
// for the AI.
function partsReview(queue) {
  const out = [el('h2', 'parts-title', t('reviewTitle')), el('p', 'parts-intro', t('reviewIntro'))];
  const month = todayIso().slice(0, 7);
  const score = accuracy(itemUses, month);
  if (score.made) out.push(el('p', 'match-score', t('accuracyLine', score)));

  const section = (title, hint, rows, empty) => {
    out.push(el('h3', 'shop-group parts-group', `${title}${rows.length ? ` · ${rows.length}` : ''}`), el('p', 'parts-hint', hint));
    if (!rows.length && empty) out.push(el('p', 'parts-empty parts-good', empty));
    out.push(...rows);
  };
  section(t('checkTitle'), t('checkIntro'), receiptsToCheck(), t('nothingToCheck'));
  const typed = Object.assign(el('button', 'link-btn type-receipt-link', t('typeReceipt')), { type: 'button' });
  typed.addEventListener('click', () => openReceipt(null));
  out.push(typed);
  section(t('secDoubts'), t('secDoubtsHint'), queue.doubts.map((x) => matchCard(x)), t('nothingToCheck'));
  section(t('secNoWork'), t('secNoWorkHint'), queue.noWork.map(noWorkCard), t('nothingToCheck'));
  section(t('secOldStock'), t('secOldStockHint'), oldStock(receipts, itemUses, todayIso()).map(oldStockCard), t('nothingToCheck'));
  section(t('secNoParts'), t('secNoPartsHint'), queue.noParts.map(noPartsCard), t('nothingToCheck'));

  // The AI's own matches, folded: a spot check.
  const head = el('button', `shop-group section-toggle parts-work-head${showRecent ? ' open' : ''}`);
  head.type = 'button';
  head.setAttribute('aria-expanded', String(showRecent));
  head.append(el('span', 'section-label', t('secRecent')), el('span', 'section-count', String(queue.recent.length)), el('span', 'section-chevron', showRecent ? '▾' : '▸'));
  head.addEventListener('click', () => { showRecent = !showRecent; renderParts(); });
  out.push(head);
  if (showRecent) out.push(...(queue.recent.length ? queue.recent.map((x) => matchCard(x)) : [el('p', 'muted', t('noRecentMatches'))]));

  out.push(...spendBox(), ...aiNotesBox());
  return out;
}

// A match the AI made: the item, the repair, how sure it was and why.
function matchCard({ use, item, entry }) {
  const card = el('div', `match-card match-${use.status}`);
  const cost = item.unitCost != null ? money(item.unitCost * use.qty) : '';
  card.append(
    el('p', 'match-item', itemLine(item, use.qty)),
    el('p', 'match-cost', cost),
    el('p', 'match-meta', [item.vendor, dateText(item.date), item.partNumber].filter(Boolean).join(' · ')),
    el('p', 'match-arrow', `→ ${entry ? repairLine(entry) : t('truckOnly', use.vehicleName ?? unitName(use.vehicleId))}`),
  );
  if (use.reason) card.append(el('p', 'match-why', t('aiSure', use.confidence ?? 0, use.reason)));
  const right = Object.assign(el('button', 'btn match-right', t('right')), { type: 'button' });
  right.addEventListener('click', () => confirmUse(use));
  const change = Object.assign(el('button', 'btn btn-ghost', t('change')), { type: 'button' });
  change.addEventListener('click', () => pickForItem(item, use));
  const actions = el('div', 'match-actions');
  actions.append(right, change, receiptLink(item));
  card.append(actions);
  return card;
}

function receiptLink(item) {
  const r = receiptOf(item);
  const b = Object.assign(el('button', 'link-btn', t('seeReceipt')), { type: 'button' });
  b.hidden = !r?.hasPhoto;
  b.addEventListener('click', () => r && showReceiptPhoto(r));
  return b;
}

// A part bought 2+ weeks ago that no work explains.
function noWorkCard(item) {
  const card = el('div', 'match-card match-nowork');
  card.append(
    el('p', 'match-item', itemLine(item, item.remaining)),
    el('p', 'match-cost', item.unitCost != null ? money(item.unitCost * item.remaining) : ''),
    el('p', 'match-meta', [item.vendor, dateText(item.date), item.partNumber].filter(Boolean).join(' · ')),
    el('p', 'match-arrow', [item.vehicleId ? t('boughtFor', unitName(item.vehicleId)) : null, t('daysNoWork', daysBetween(item.date, todayIso()))].filter(Boolean).join(' · ')),
  );
  const pick = Object.assign(el('button', 'btn match-right', t('pickRepair')), { type: 'button' });
  pick.addEventListener('click', () => pickForItem(item, null));
  const shelf = Object.assign(el('button', 'btn btn-ghost', t('stillOnShelf')), { type: 'button' });
  shelf.addEventListener('click', () => snoozeItem(item, null));
  const actions = el('div', 'match-actions');
  actions.append(pick, shelf, receiptLink(item));
  card.append(actions);
  return card;
}

// A stock batch bought 60+ days ago that no work log used: the shop used it,
// or it's still on the shelf (asked again in 30 days).
function oldStockCard(lot) {
  const card = el('div', 'match-card match-nowork');
  const name = partById(lot.part)?.name ?? lot.part;
  card.append(
    el('p', 'match-item', `${qtyText(lot.remaining)} × ${name}`),
    el('p', 'match-cost', lot.unitCost != null ? money(lot.unitCost * lot.remaining) : ''),
    el('p', 'match-meta', [lot.vendor, dateText(lot.date)].filter(Boolean).join(' · ')),
    el('p', 'match-arrow', t('daysOnShelf', daysBetween(lot.date, todayIso()))),
  );
  const write = (data) => {
    const ref = useRef(null);
    return setDoc(ref, { id: ref.id, receiptId: lot.receiptId, lineId: lot.lineId, part: lot.part, by: 'admin', createdAt: serverTimestamp(), ...data })
      .catch((err) => showAppError(t('couldNotSave', err.message)));
  };
  const shop = Object.assign(el('button', 'btn match-right', t('usedByShop')), { type: 'button' });
  shop.addEventListener('click', () => write({ qty: lot.remaining, shop: true, status: 'confirmed' }));
  const shelf = Object.assign(el('button', 'btn btn-ghost', t('stillOnShelf')), { type: 'button' });
  shelf.addEventListener('click', () => write({ qty: 0, status: 'snooze', until: new Date(Date.now() + 30 * DAY_MS).toLocaleDateString('en-CA') }));
  const actions = el('div', 'match-actions');
  actions.append(shop, shelf, receiptLink(lot));
  card.append(actions);
  return card;
}

// A repair a week or more old with no bought part tied to it.
function noPartsCard(entry) {
  const card = el('div', 'match-card match-noparts');
  card.append(el('p', 'match-item', repairLine(entry)), el('p', 'match-meta', t('noPartsFound')));
  const pick = Object.assign(el('button', 'btn match-right', t('pickParts')), { type: 'button' });
  pick.addEventListener('click', () => pickForRepair(entry));
  const none = Object.assign(el('button', 'btn btn-ghost', t('noPartsNeeded')), { type: 'button' });
  none.addEventListener('click', async () => {
    none.disabled = true;
    try {
      await setDoc(doc(db, 'serviceLog', entry.id), { noParts: true }, { merge: true });
    } catch (err) {
      none.disabled = false;
      showAppError(t('couldNotSave', err.message));
    }
  });
  const actions = el('div', 'match-actions');
  actions.append(pick, none);
  card.append(actions);
  return card;
}

const useRef = (id) => (id ? doc(db, 'itemUses', id) : doc(collection(db, 'itemUses')));
const correctionRef = () => doc(collection(db, 'corrections'));
const repairOf = (id) => serviceLog.find((e) => e.id === id) ?? null;
const placeOf = (use) => {
  if (!use) return null;
  const e = use.logId ? repairOf(use.logId) : null;
  if (e) return { repair: repairText(e), truck: e.vehicleName ?? unitName(e.vehicleId), date: e.date ?? null };
  return { truck: use.vehicleName ?? unitName(use.vehicleId) };
};

async function confirmUse(use) {
  try {
    await setDoc(useRef(use.id), { status: 'confirmed', checkedAt: serverTimestamp() }, { merge: true });
  } catch (err) {
    showAppError(t('couldNotSave', err.message));
  }
}

// Admin's choice for an item: a repair, a truck with no repair, or nothing
// yet. Replaces the AI's match (if any) and records the correction.
async function placeItem(item, fromUse, choice) {
  const batch = writeBatch(db);
  // Picking the same repair the AI picked just confirms it.
  if (fromUse && choice.entry && fromUse.logId === choice.entry.id && choice.qty === fromUse.qty) {
    batch.set(useRef(fromUse.id), { status: 'confirmed', checkedAt: serverTimestamp() }, { merge: true });
    return batch.commit();
  }
  if (fromUse) batch.set(useRef(fromUse.id), { status: 'rejected', checkedAt: serverTimestamp() }, { merge: true });
  const e = choice.entry;
  const unitId = e?.vehicleId ?? choice.unitId;
  if (unitId) {
    const ref = useRef(null);
    const trailer = e ? e.assetType === 'trailer' : trailers.some((c) => c.id === unitId);
    batch.set(ref, {
      id: ref.id, receiptId: item.receiptId, lineId: item.lineId, qty: choice.qty, logId: e?.id ?? null,
      vehicleId: unitId, vehicleName: e?.vehicleName ?? unitName(unitId), assetType: trailer ? 'trailer' : 'truck',
      shop: false, by: 'admin', status: 'confirmed', itemText: item.text, createdAt: serverTimestamp(),
    });
  }
  if (choice.shelf) {
    const ref = useRef(null);
    batch.set(ref, {
      id: ref.id, receiptId: item.receiptId, lineId: item.lineId, qty: 0, status: 'snooze', by: 'admin',
      until: new Date(Date.now() + 30 * DAY_MS).toLocaleDateString('en-CA'), itemText: item.text, createdAt: serverTimestamp(),
    });
  }
  // What the AI said and what admin said instead: the AI reads these.
  if (fromUse || choice.teach) {
    batch.set(correctionRef(), {
      type: 'match', at: new Date().toISOString(), itemText: item.text, partNumber: item.partNumber ?? null,
      vendor: item.vendor ?? null, itemDate: item.date ?? null,
      ai: fromUse ? { ...placeOf(fromUse), confidence: fromUse.confidence ?? null } : null,
      admin: choice.shelf ? { shelf: true } : e ? { repair: repairText(e), truck: e.vehicleName ?? unitName(e.vehicleId), date: e.date } : { truck: unitName(unitId) },
    });
  }
  return batch.commit();
}

const snoozeItem = (item, fromUse) => placeItem(item, fromUse, { shelf: true, qty: 0 }).catch((err) => showAppError(t('couldNotSave', err.message)));

// Not a repair part after all: the receipt line becomes shop supplies, which
// is a reading correction (the reader called it a part).
async function shopItem(item, fromUse) {
  const r = receiptOf(item);
  if (!r) return;
  const batch = writeBatch(db);
  const lines = (r.lines ?? []).map((l, i) => ((l.id ?? `i${i}`) === item.lineId ? { ...l, id: item.lineId, kind: 'supplies', to: 'shop', vehicleId: null } : l));
  batch.set(doc(db, 'receipts', r.id), { lines }, { merge: true });
  if (fromUse) batch.set(useRef(fromUse.id), { status: 'rejected', checkedAt: serverTimestamp() }, { merge: true });
  batch.set(correctionRef(), {
    type: 'reading', at: new Date().toISOString(), vendor: r.vendor ?? null, text: item.text, partNumber: item.partNumber ?? null,
    before: { part: null, kind: item.kind, truck: item.vehicleId ? unitName(item.vehicleId) : null, qty: item.qty, price: null },
    after: { part: null, kind: 'supplies', truck: null, qty: item.qty, price: null },
  });
  if (fromUse) {
    batch.set(correctionRef(), {
      type: 'match', at: new Date().toISOString(), itemText: item.text, partNumber: item.partNumber ?? null,
      vendor: item.vendor ?? null, itemDate: item.date ?? null, ai: { ...placeOf(fromUse), confidence: fromUse.confidence ?? null }, admin: { shop: true },
    });
  }
  await batch.commit();
}

// Pick where an item went: the repairs around its date (its trucks first),
// a truck with no repair recorded, shop supplies, or still on the shelf.
function pickForItem(item, fromUse) {
  const left = item.qty - itemUses.filter((u) => itemKey(u.receiptId, u.lineId) === item.key && ['auto', 'doubt', 'confirmed'].includes(u.status) && u.id !== fromUse?.id)
    .reduce((s, u) => s + (Number(u.qty) || 0), 0);
  const body = partsDialog(item.text || t('receipt'), [item.vendor, dateText(item.date), money(item.cost ?? 0)].filter(Boolean).join(' · '));
  let qty = fromUse?.qty ?? Math.max(left, 1);
  if (left > 1) {
    const qtyPick = selectOf(Array.from({ length: Math.floor(left) }, (_, i) => [i + 1, String(i + 1)]), qty);
    qtyPick.addEventListener('change', () => { qty = Number(qtyPick.value); });
    const field = el('label', 'field');
    field.append(el('span', null, t('howMany')), qtyPick);
    body.append(field);
  }
  const done = (p) => p.then(() => $('pdlg').close()).catch((err) => showAppError(t('couldNotSave', err.message)));
  const allowed = item.vehicleId ? [item.vehicleId] : item.truckChoices ?? [];
  // The AI's pick first, then the item's trucks, then the closest dates.
  const around = serviceLog.filter((e) => isRepair(e) && inWindow(item, e))
    .sort((a, b) => Number(b.id === fromUse?.logId) - Number(a.id === fromUse?.logId)
      || Number(allowed.includes(b.vehicleId)) - Number(allowed.includes(a.vehicleId))
      || Math.abs(daysBetween(item.date, a.date)) - Math.abs(daysBetween(item.date, b.date)));
  body.append(el('div', 'section-title', t('repairsAround')));
  if (!around.length) body.append(el('p', 'muted', t('noRepairsAround')));
  const list = el('div', 'pick-list');
  for (const e of around) {
    const b = Object.assign(el('button', `pick-row${fromUse?.logId === e.id ? ' current' : ''}`), { type: 'button' });
    b.append(el('span', 'pick-main', repairLine(e)));
    if (fromUse?.logId === e.id) b.append(el('span', 'pick-tag', t('aiPick')));
    b.addEventListener('click', () => done(placeItem(item, fromUse, { entry: e, qty, teach: true })));
    list.append(b);
  }
  body.append(list);

  // Bought for a truck, but no repair was recorded for it.
  body.append(el('div', 'section-title', t('truckNoRepair')));
  const units = [...vehicles, ...trailers].filter((v) => v.name).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  const unit = selectOf([['', t('choosePart')], ...units.map((v) => [v.id, v.name])], allowed[0] ?? '');
  const unitGo = Object.assign(el('button', 'btn btn-ghost', t('save')), { type: 'button' });
  unitGo.addEventListener('click', () => { if (unit.value) done(placeItem(item, fromUse, { unitId: unit.value, qty, teach: true })); });
  const unitRow = el('div', 'pick-unit');
  unitRow.append(unit, unitGo);
  body.append(unitRow);

  const other = el('div', 'match-actions pick-other');
  const shop = Object.assign(el('button', 'btn btn-ghost', t('shopSupplies')), { type: 'button' });
  shop.addEventListener('click', () => done(shopItem(item, fromUse)));
  const shelf = Object.assign(el('button', 'btn btn-ghost', t('stillOnShelf')), { type: 'button' });
  shelf.addEventListener('click', () => done(placeItem(item, fromUse, { shelf: true, qty: 0 })));
  other.append(shop, shelf);
  body.append(other);
}

// Pick the parts a repair used, from the items bought around its date that
// aren't tied to anything (its truck's first).
function pickForRepair(entry) {
  const body = partsDialog(repairText(entry) || t('repair'), [entry.vehicleName ?? unitName(entry.vehicleId), dateText(entry.date)].filter(Boolean).join(' · '));
  const open = openItems(receiptItems(receipts), itemUses, { today: todayIso(), days: 120 })
    .filter((it) => inWindow(it, entry))
    .sort((a, b) => Number(b.vehicleId === entry.vehicleId) - Number(a.vehicleId === entry.vehicleId) || Math.abs(daysBetween(a.date, entry.date)) - Math.abs(daysBetween(b.date, entry.date)));
  body.append(el('div', 'section-title', t('partsAround')));
  if (!open.length) body.append(el('p', 'muted', t('noPartsAround')));
  const list = el('div', 'pick-list');
  for (const it of open) {
    const b = Object.assign(el('button', 'pick-row'), { type: 'button' });
    b.append(
      el('span', 'pick-main', itemLine(it, it.remaining)),
      el('span', 'pick-sub', [it.vendor, dateText(it.date), it.unitCost != null ? money(it.unitCost * it.remaining) : null, it.vehicleId ? t('boughtFor', unitName(it.vehicleId)) : null].filter(Boolean).join(' · ')),
    );
    b.addEventListener('click', () => placeItem(it, null, { entry, qty: it.remaining, teach: true })
      .then(() => $('pdlg').close()).catch((err) => showAppError(t('couldNotSave', err.message))));
    list.append(b);
  }
  body.append(list);
}

// What each truck cost: everything its work used, each from a receipt.
function spendBox() {
  const today = todayIso();
  const from = spendPeriod === 'month' ? `${today.slice(0, 7)}-01` : spendPeriod === 'year' ? `${today.slice(0, 4)}-01-01`
    : new Date(Date.now() - 90 * DAY_MS).toLocaleDateString('en-CA');
  const s = spending({ receipts, uses: itemUses, log: serviceLog, parts: partsList, from, to: today });
  const period = selectOf(SPEND_PERIODS.map((p) => [p, t('spendPeriods')[p]]), spendPeriod);
  period.addEventListener('change', () => { spendPeriod = period.value; renderParts(); });
  const out = [el('h3', 'shop-group parts-group', t('spentTitle')), period];
  const rows = el('div', 'buy-lines spend-lines');
  for (const u of s.units) {
    const row = el('div', 'buy-line spend-line');
    row.append(
      el('span', 'buy-text', `${unitName(u.unitId)}`),
      el('span', 'spend-split', u.unpriced ? t('noReceiptYet', u.unpriced) : ''),
      el('strong', null, money(u.total)),
    );
    rows.append(row);
  }
  if (s.units.length) out.push(rows);
  else out.push(el('p', 'muted', t('noSpendYet')));
  out.push(el('p', 'receipt-tax', t('shopCosts', money(s.shop.supplies), money(s.shop.tools))));
  if (s.open) out.push(el('p', 'receipt-tax', t('notMatchedYet', money(s.open))));
  if (s.waiting) out.push(el('p', 'receipt-tax', t('waitingLine', money(s.waiting))));
  return out;
}

// What admin tells the AI; it reads this before every receipt and match.
function aiNotesBox() {
  const box = el('div', 'ai-notes');
  const area = Object.assign(el('textarea'), { rows: 4, value: aiMemory.notes ?? '', placeholder: t('aiNotesPh') });
  const save = Object.assign(el('button', 'btn btn-ghost', t('saveNotes')), { type: 'button' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await setDoc(doc(db, 'meta', 'aiMemory'), { notes: area.value.trim(), updatedAt: serverTimestamp() }, { merge: true });
      save.textContent = t('notesSaved');
      setTimeout(() => { save.textContent = t('saveNotes'); save.disabled = false; }, 1500);
    } catch (err) {
      save.disabled = false;
      showAppError(t('couldNotSave', err.message));
    }
  });
  box.append(el('h3', 'shop-group parts-group', t('aiNotes')), el('p', 'parts-hint', t('aiNotesHint')), area, save);
  return [box];
}

// ---- Analytics: one truck or trailer, month by month or week by week ------------
// What it cost (everything its work used, each from a receipt),
// how far it drove (Samsara's daily odometer), and what work it had. Admin
// picks one unit or the whole fleet, and the dates (a month by week, a year by month, a range, or
// everything); each period opens to what was in it.

const AN_MODES = ['month', 'year', 'range', 'all'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const AN_KEY = 'aslog.analytics';
let anSettings = (() => { try { return JSON.parse(localStorage.getItem(AN_KEY)) ?? {}; } catch { return {}; } })();
const anDays = {}; // vehicleId -> odometerDaily days ({} when none)
const anLoading = new Set();
let anOpenPeriod = null; // the period card shown open

function saveAnSettings(change) {
  anSettings = { ...anSettings, ...change };
  try { localStorage.setItem(AN_KEY, JSON.stringify(anSettings)); } catch { /* not remembered */ }
  anOpenPeriod = null;
  renderAnalytics();
}

function anUnits() {
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
  return [
    ...vehicles.filter((v) => v.name).sort(byName).map((v) => ({ id: v.id, name: v.name, trailer: false })),
    ...trailers.filter((c) => c.name).sort(byName).map((c) => ({ id: c.id, name: c.name, trailer: true })),
  ];
}

// Samsara's daily odometer readings for a truck, loaded once.
async function loadAnDays(id) {
  if (anLoading.has(id) || id in anDays) return;
  anLoading.add(id);
  try {
    const snap = await getDoc(doc(db, 'odometerDaily', id));
    anDays[id] = snap.exists() ? snap.data().days ?? {} : {};
  } catch {
    anDays[id] = {};
  }
  anLoading.delete(id);
  renderAnalytics();
}

// Every truck's readings, for the fleet: loaded together, drawn once.
let anFleetLoading = false;
async function loadAnFleetDays(ids) {
  const missing = ids.filter((id) => !(id in anDays) && !anLoading.has(id));
  if (anFleetLoading || !missing.length) return;
  anFleetLoading = true;
  missing.forEach((id) => anLoading.add(id));
  await Promise.all(missing.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, 'odometerDaily', id));
      anDays[id] = snap.exists() ? snap.data().days ?? {} : {};
    } catch {
      anDays[id] = {};
    }
    anLoading.delete(id);
  }));
  anFleetLoading = false;
  renderAnalytics();
}

// Chart ticks: a clean top value (0 / half / top) and compact money ($1.5K).
function niceTop(max) {
  if (!(max > 0)) return 100;
  const step = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 2.5, 5, 10].map((m) => m * step).find((v) => v >= max);
}
const compactMoney = (n) => (n >= 1000 ? `$${Number((n / 1000).toFixed(n >= 10000 ? 0 : 1))}K` : `$${Math.round(n)}`);
const anPeriodName = (p, view) => (view === 'week'
  ? `Week of ${niceDate(p.from).replace(/, \d{4}$/, '')}`
  : new Date(`${p.from}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
const workText = (r) => [r.service && plural(r.service, 'service'), r.repair && plural(r.repair, 'repair'), r.tires && `${fmt.format(r.tires)} tire change${r.tires === 1 ? '' : 's'}`, r.batteries && `${fmt.format(r.batteries)} battery change${r.batteries === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'No work logged';
const costText = (r) => [
  `Parts ${money(r.parts)}`,
  r.shop ? `shop supplies & tools ${money(r.shop)}` : null,
  r.shopShare ? `shop share ${money(r.shopShare)}` : null,
  r.unpriced ? `${fmt.format(r.unpriced)} with no receipt yet` : null,
].filter(Boolean).join(' · ');
const milesText = (r) => (r.miles == null ? null : `${fmt.format(r.miles)} mi${r.perMile != null ? ` · $${r.perMile.toFixed(2)}/mi` : ''}`);

function renderAnalytics() {
  if (currentTab() !== 'analytics') return;
  const units = anUnits();
  const fleet = anSettings.scope === 'fleet';
  for (const b of $('an-scope').querySelectorAll('button')) {
    const on = (b.dataset.scope === 'fleet') === fleet;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('an-unit-field').hidden = fleet;
  const unitSel = $('an-unit');
  const options = units.map((u) => [u.id, u.trailer ? `Trailer ${u.name}` : u.name]);
  if ([...unitSel.options].map((o) => o.value).join() !== options.map(([v]) => v).join()) {
    unitSel.replaceChildren(...options.map(([v, label]) => Object.assign(el('option', null, label), { value: v })));
  }
  const body = $('an-body');
  const unit = fleet ? null : units.find((u) => u.id === anSettings.unit) ?? units[0];
  if (!units.length) { body.replaceChildren(el('p', 'muted', 'No trucks yet.')); return; }
  if (unit) unitSel.value = unit.id;

  const trucks = units.filter((u) => !u.trailer).map((u) => u.id);
  let days = null;
  if (fleet) loadAnFleetDays(trucks);
  else if (!unit.trailer) {
    if (!(unit.id in anDays)) loadAnDays(unit.id);
    days = anDays[unit.id] ?? null;
  }
  const today = todayIso();
  const events = costEvents({ receipts, uses: itemUses, log: serviceLog });
  // The first record (the unit's or the fleet's), for "All"; the fleet's, for the years offered.
  const firstOf = (dates) => dates.filter(Boolean).sort()[0] ?? today;
  const fleetFirst = firstOf(serviceLog.map((e) => e.date));
  const first = fleet
    ? firstOf([...serviceLog.filter(workKind).map((e) => e.date), ...events.filter((ev) => ev.kind !== 'open').map((ev) => ev.date)])
    : firstOf([...serviceLog.filter((e) => e.vehicleId === unit.id && workKind(e)).map((e) => e.date), ...events.filter((ev) => ev.unitId === unit.id).map((ev) => ev.date)]);
  const choice = anChoice(today);
  renderAnDates(choice, today, fleetFirst, first, fleet);
  const { grain, periods } = periodsFor(choice, today, first);
  if (!periods.length) {
    body.replaceChildren(el('p', 'parts-empty', 'Nothing to show yet for these dates.'));
    return;
  }
  if (fleet) {
    const daysById = Object.fromEntries(trucks.filter((id) => id in anDays).map((id) => [id, anDays[id]]));
    const { rows, totals, byUnit } = fleetBreakdown({ units, periods, events, log: serviceLog, daysById });
    const loading = trucks.some((id) => !(id in anDays));
    body.replaceChildren(anTiles(totals, null, { loading }), anChart(rows, grain), ...anFleetUnits(byUnit, loading), ...anCards(rows, null, grain, events));
    return;
  }
  const { rows, totals } = unitBreakdown({ unitId: unit.id, periods, events, log: serviceLog, days });
  // Shop share: supplies and tools split evenly by the trucks, an estimate kept apart.
  if (anSettings.shopShare && !unit.trailer) {
    const shares = shopShare({ periods, events, trucks: trucks.length });
    rows.forEach((r, i) => {
      Object.assign(r, { shopShare: shares[i].share, shopTotal: shares[i].shop, trucks: shares[i].trucks });
      r.total = Math.round((r.parts + r.shopShare) * 100) / 100;
      r.perMile = r.miles ? Math.round((r.total / r.miles) * 100) / 100 : null;
    });
    totals.shopShare = Math.round(rows.reduce((s, r) => s + r.shopShare, 0) * 100) / 100;
    totals.total = Math.round((totals.parts + totals.shopShare) * 100) / 100;
    totals.perMile = totals.miles ? Math.round((totals.total / totals.miles) * 100) / 100 : null;
  }
  const share = el('label', 'an-share');
  const box = Object.assign(el('input'), { type: 'checkbox', id: 'an-shop-share', checked: Boolean(anSettings.shopShare) });
  box.addEventListener('change', () => saveAnSettings({ shopShare: box.checked }));
  share.append(box, el('span', null, `Include a share of shop supplies and tools (shop total ÷ ${fmt.format(trucks.length)} trucks)`));
  share.hidden = unit.trailer;
  const range = { from: periods[0].from, to: periods.at(-1).to };
  body.replaceChildren(anTiles(totals, unit), share, anChart(rows, grain), ...anReceipts(unit, range, events), ...anCards(rows, unit, grain, events));
}

// The receipts behind a unit's costs in the dates: one row each, with what
// this unit took from it; each opens the photo.
function anReceipts(unit, range, events) {
  const mine = events.filter((ev) => ev.unitId === unit.id && ev.kind === 'parts' && ev.receiptId && ev.date >= range.from && ev.date <= range.to);
  const byReceipt = new Map();
  for (const ev of mine) {
    const x = byReceipt.get(ev.receiptId) ?? { receiptId: ev.receiptId, amount: 0, lines: [] };
    x.amount += ev.amount;
    x.lines.push(ev);
    byReceipt.set(ev.receiptId, x);
  }
  const unpriced = events.filter((ev) => ev.unitId === unit.id && ev.kind === 'unpriced' && ev.date >= range.from && ev.date <= range.to);
  if (!byReceipt.size && !unpriced.length) return [];
  const list = el('div', 'an-receipts');
  for (const x of [...byReceipt.values()].sort((a, b) => b.amount - a.amount)) {
    const what = x.lines.map((ev) => anCostName(ev)).join(', ');
    const row = el('div', 'an-receipt');
    row.append(receiptChip(x.receiptId, `${what} → ${unit.name}`), el('span', 'an-receipt-what', what), el('strong', 'an-row-amount', money(x.amount)));
    list.append(row);
  }
  for (const ev of unpriced) {
    const row = el('div', 'an-receipt an-receipt-none');
    row.append(el('span', 'rc-chip rc-none', 'No receipt yet'), el('span', 'an-receipt-what', `${anCostName(ev)} · ${dateText(ev.date)}`), el('span', 'an-row-amount', '—'));
    list.append(row);
  }
  const title = `Receipts behind ${money(mine.reduce((s, ev) => s + ev.amount, 0))}`;
  return [el('h3', 'an-title', title), list];
}

// "4 × Battery", "Brake drum DB1655B".
const anCostName = (ev) => {
  const name = ev.part ? partById(ev.part)?.name ?? ev.part : ev.text || t('receipt');
  return ev.qty && (ev.part || ev.qty !== 1) ? `${qtyText(ev.qty)} × ${name}` : name;
};

// The fleet's trucks and trailers for the dates, biggest spend first; tap one
// to see it by itself. Units with no costs wait behind a button.
let anShowIdle = false;
function anFleetUnits(byUnit, loading) {
  const busy = byUnit.filter((u) => u.total);
  const idle = byUnit.filter((u) => !u.total);
  const top = Math.max(...busy.map((u) => u.total), 0);
  const list = el('div', 'an-units');
  const row = (u) => {
    const b = el('button', 'an-unit');
    b.type = 'button';
    const track = el('span', 'an-unit-track');
    const bar = el('span', 'an-unit-bar');
    bar.style.width = `${top ? (u.total / top) * 100 : 0}%`;
    if (u.total) track.append(bar);
    const miles = u.trailer || u.miles == null ? (loading && !u.trailer ? 'miles loading…' : null) : `${fmt.format(u.miles)} mi${u.perMile != null ? ` · $${u.perMile.toFixed(2)}/mi` : ''}`;
    b.append(el('span', 'an-unit-name', u.trailer ? `Trailer ${u.name}` : u.name), track, el('span', 'an-unit-total', money(u.total)),
      el('span', 'an-unit-note', [miles, workText(u)].filter(Boolean).join(' · ')));
    b.setAttribute('aria-label', `${u.name}: ${money(u.total)}. Show only ${u.name}`);
    b.addEventListener('click', () => saveAnSettings({ scope: 'unit', unit: u.id }));
    return b;
  };
  list.append(...busy.map(row));
  if (!busy.length) list.append(el('p', 'muted', 'No costs for these dates.'));
  const out = [el('h3', 'an-title', 'By truck'), list];
  if (idle.length) {
    if (anShowIdle) list.append(...idle.map(row));
    const more = Object.assign(el('button', 'btn btn-ghost an-more', anShowIdle ? 'Hide units with no costs' : `${plural(idle.length, 'more unit')} with no costs`), { type: 'button' });
    more.addEventListener('click', () => { anShowIdle = !anShowIdle; renderAnalytics(); });
    out.push(more);
  }
  return out;
}

// The date choice, with defaults: this month, this year, the last 90 days.
function anChoice(today) {
  const mode = AN_MODES.includes(anSettings.mode) ? anSettings.mode : 'month';
  return {
    mode,
    month: /^\d{4}-\d{2}$/.test(anSettings.month ?? '') ? anSettings.month : today.slice(0, 7),
    year: /^\d{4}$/.test(anSettings.year ?? '') ? anSettings.year : today.slice(0, 4),
    from: anSettings.from || new Date(Date.now() - 90 * DAY_MS).toLocaleDateString('en-CA'),
    to: anSettings.to || today,
  };
}

// Month / Year / Range / All, and under it what that choice needs.
function renderAnDates(choice, today, fleetFirst, first, fleet) {
  for (const b of $('an-modes').querySelectorAll('button')) {
    const on = b.dataset.mode === choice.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  const years = [];
  for (let y = Number(today.slice(0, 4)); y >= Number(fleetFirst.slice(0, 4)); y -= 1) years.push(String(y));
  const yearSel = (value, onPick) => {
    const sel = selectOf(years.map((y) => [y, y]), years.includes(value) ? value : years[0]);
    sel.setAttribute('aria-label', 'Year');
    sel.addEventListener('change', () => onPick(sel.value));
    return sel;
  };
  const pick = $('an-pick');
  if (choice.mode === 'month') {
    const [y, m] = choice.month.split('-');
    const month = selectOf(MONTH_NAMES.map((name, i) => [String(i + 1).padStart(2, '0'), name]), m);
    month.setAttribute('aria-label', 'Month');
    month.addEventListener('change', () => saveAnSettings({ month: `${y}-${month.value}` }));
    pick.replaceChildren(month, yearSel(y, (year) => saveAnSettings({ month: `${year}-${m}` })));
  } else if (choice.mode === 'year') {
    pick.replaceChildren(yearSel(choice.year, (year) => saveAnSettings({ year })));
  } else if (choice.mode === 'range') {
    const date = (label, value, key) => {
      const input = Object.assign(el('input'), { type: 'date', value, max: today });
      input.addEventListener('change', () => { if (input.value) saveAnSettings({ [key]: input.value }); });
      const wrap = el('label', 'field');
      wrap.append(el('span', null, label), input);
      return wrap;
    };
    pick.replaceChildren(date('From', choice.from, 'from'), date('To', choice.to, 'to'));
  } else {
    pick.replaceChildren(el('p', 'an-since', `Since ${niceDate(first)}, the first record for ${fleet ? 'the fleet' : 'this unit'}`));
  }
}

// The totals for the whole range: spent, miles, cost per mile, work. With no
// unit, the fleet's (miles from every truck with readings).
function anTiles(totals, unit, { loading = false } = {}) {
  const tiles = el('div', 'an-tiles');
  const tile = (label, value, note) => {
    const t2 = el('div', 'an-tile');
    t2.append(el('span', 'an-tile-label', label), el('span', 'an-tile-value', value));
    if (note) t2.append(el('span', 'an-tile-note', note));
    return t2;
  };
  tiles.append(
    tile('Spent', money(totals.total), costText(totals)),
    unit
      ? tile('Miles', totals.miles == null ? '—' : fmt.format(totals.miles), unit.trailer ? 'Trailers have no odometer in Samsara' : totals.miles == null ? 'Loading Samsara readings…' : null)
      : tile('Miles', totals.miles == null ? '—' : fmt.format(totals.miles), loading ? 'Loading Samsara readings…' : `${plural(totals.reporting, 'truck')} with readings`),
    tile('Cost per mile', totals.perMile == null ? '—' : `$${totals.perMile.toFixed(2)}`),
    tile('Work', fmt.format(totals.service + totals.repair + totals.tires + totals.batteries), workText(totals)),
  );
  return tiles;
}

// Spent per period: one column each, oldest on the left. Hover or focus a
// column for its numbers; tap it to open that period below.
function anChart(rows, view) {
  const wrap = el('section', 'an-chart');
  wrap.append(el('h3', 'an-title', `Spent per ${view}`));
  const top = niceTop(Math.max(...rows.map((r) => r.total), 0));
  const plot = el('div', 'an-plot');
  for (const f of [1, 0.5, 0]) {
    const line = el('div', 'an-grid');
    line.style.bottom = `${f * 100}%`;
    line.append(el('span', 'an-tick', compactMoney(top * f)));
    plot.append(line);
  }
  const cols = el('div', 'an-cols');
  const tip = el('div', 'an-tip');
  tip.hidden = true;
  const maxRow = rows.reduce((m, r) => (r.total > (m?.total ?? 0) ? r : m), null);
  const every = Math.ceil(rows.length / 8);
  rows.forEach((r, i) => {
    const col = el('button', `an-col${anOpenPeriod === r.key ? ' open' : ''}`);
    col.type = 'button';
    col.setAttribute('aria-label', `${anPeriodName(r, view)}: ${money(r.total)}`);
    const bar = el('span', 'an-bar');
    bar.style.height = `${(r.total / top) * 100}%`;
    if (r === maxRow) bar.append(el('span', 'an-cap', compactMoney(r.total)));
    col.append(bar, el('span', 'an-x', i % every === 0 || i === rows.length - 1 ? r.label : ''));
    const show = () => {
      tip.replaceChildren(el('strong', null, money(r.total)), el('span', null, anPeriodName(r, view)),
        el('span', null, `Parts ${money(r.parts)}${r.shop ? ` · shop ${money(r.shop)}` : ''}${r.shopShare ? ` · shop share ${money(r.shopShare)}` : ''}`), ...(milesText(r) ? [el('span', null, milesText(r))] : []));
      tip.hidden = false;
      // Centered over the column, kept inside the chart.
      const half = tip.offsetWidth / 2;
      const left = col.offsetLeft + col.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(left, half), cols.offsetWidth - half)}px`;
    };
    col.addEventListener('pointerenter', show);
    col.addEventListener('focus', show);
    col.addEventListener('pointerleave', () => { tip.hidden = true; });
    col.addEventListener('blur', () => { tip.hidden = true; });
    col.addEventListener('click', () => {
      anOpenPeriod = anOpenPeriod === r.key ? null : r.key;
      renderAnalytics();
      document.querySelector('.an-card.open')?.scrollIntoView({ block: 'nearest' });
    });
    cols.append(col);
  });
  plot.append(cols, tip);
  wrap.append(plot);
  return wrap;
}

// One card per period, newest first; open shows what was in it.
function anCards(rows, unit, view, events) {
  const out = [el('h3', 'an-title', `By ${view}`)];
  for (const r of [...rows].reverse()) {
    const open = anOpenPeriod === r.key;
    const card = el('div', `an-card${open ? ' open' : ''}`);
    const head = el('button', 'an-card-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    head.append(el('span', 'an-card-name', anPeriodName(r, view)), el('span', 'an-card-total', money(r.total)));
    head.addEventListener('click', () => { anOpenPeriod = open ? null : r.key; renderAnalytics(); });
    card.append(head, el('p', 'an-card-line', [milesText(r), workText(r)].filter(Boolean).join(' · ')));
    if (r.total || r.unpriced) card.append(el('p', 'an-card-line', costText(r)));
    if (open) card.append(unit ? anDetails(r, unit, events) : anFleetDetails(r, events));
    out.push(card);
  }
  return out;
}

// What a period held: the work logged and what each cost.
function anDetails(r, unit, events) {
  const box = el('div', 'an-details');
  const inP = (d) => d && d >= r.from && d <= r.to;
  const work = serviceLog.filter((e) => e.vehicleId === unit.id && inP(e.date) && workKind(e))
    .sort((a, b) => a.date.localeCompare(b.date));
  const costs = events.filter((ev) => ev.unitId === unit.id && inP(ev.date) && ['parts', 'unpriced', 'waiting'].includes(ev.kind))
    .sort((a, b) => a.date.localeCompare(b.date));
  box.append(el('div', 'an-sub', 'Work'));
  if (!work.length) box.append(el('p', 'muted', 'No work logged.'));
  for (const e of work) {
    const row = el('div', 'an-row');
    row.append(el('span', 'an-row-date', dateText(e.date)), el('span', 'an-row-text', `${e.type === 'repair' ? 'Repair: ' : ''}${repairText(e) || e.itemName || ''}`));
    box.append(row);
  }
  box.append(el('div', 'an-sub', 'Costs'));
  if (!costs.length) box.append(el('p', 'muted', 'No costs.'));
  for (const ev of costs) {
    const row = el('div', `an-row an-cost an-cost-${ev.kind}`);
    const text = el('span', 'an-row-text');
    text.append(el('span', null, anCostName(ev)));
    if (ev.kind === 'parts' && ev.receiptId) text.append(receiptChip(ev.receiptId, `${anCostName(ev)} → ${unit.name}${ev.logId ? `, ${dateText(ev.date)} work` : ''}`));
    if (ev.kind === 'unpriced') text.append(el('span', 'rc-chip rc-none', 'No receipt yet'));
    if (ev.kind === 'waiting') text.append(el('span', 'an-tag', 'Set aside, not used yet'), receiptChip(ev.receiptId, `${anCostName(ev)} set aside for ${unit.name}`));
    const amount = ev.kind === 'unpriced' ? '—' : money(ev.amount);
    row.append(el('span', 'an-row-date', dateText(ev.date)), text, el(ev.kind === 'parts' ? 'strong' : 'span', 'an-row-amount', amount));
    box.append(row);
  }
  if (r.shopShare) {
    const row = el('div', 'an-row an-cost');
    row.append(el('span', 'an-row-date', ''), el('span', 'an-row-text', `Shop share: ${money(r.shopTotal)} shop supplies and tools ÷ ${fmt.format(r.trucks)} trucks`), el('strong', 'an-row-amount', money(r.shopShare)));
    box.append(row);
  }
  return box;
}

// What a period held fleet-wide: each unit's spend, then the shop's.
function anFleetDetails(r, events) {
  const box = el('div', 'an-details');
  box.append(el('div', 'an-sub', 'Trucks and trailers'));
  if (!r.units.length) box.append(el('p', 'muted', 'No costs.'));
  for (const u of r.units) {
    const row = el('div', 'an-row an-row-unit');
    const name = Object.assign(el('button', 'link-btn', u.trailer ? `Trailer ${u.name}` : u.name), { type: 'button' });
    name.addEventListener('click', () => saveAnSettings({ scope: 'unit', unit: u.id }));
    const text = el('span', 'an-row-text');
    text.append(name);
    row.append(text, el('strong', 'an-row-amount', money(u.total)));
    box.append(row);
  }
  const shop = events.filter((ev) => !ev.unitId && (ev.kind === 'supplies' || ev.kind === 'tools') && ev.date >= r.from && ev.date <= r.to)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (shop.length) {
    box.append(el('div', 'an-sub', 'Shop supplies and tools'));
    for (const ev of shop) {
      const row = el('div', 'an-row');
      const text = el('span', 'an-row-text');
      text.append(el('span', null, anCostName(ev)));
      if (ev.receiptId) text.append(receiptChip(ev.receiptId, `${anCostName(ev)} · shop`));
      row.append(el('span', 'an-row-date', dateText(ev.date)), text, el('strong', 'an-row-amount', money(ev.amount)));
      box.append(row);
    }
  }
  return box;
}

// ---- Parts popups: a part, a kit, a receipt -------------------------------------

function partsDialog(title, sub) {
  $('p-close').textContent = t('close');
  $('p-title').textContent = title;
  $('p-sub').textContent = sub ?? '';
  const body = $('p-body');
  body.replaceChildren();
  showDialog($('pdlg'));
  return body;
}

const numberInput = (value, { step = 'any', min = 0 } = {}) => Object.assign(el('input'), {
  type: 'number', inputMode: 'decimal', step, min, value: value ?? '',
});
function selectOf(options, value) {
  const s = el('select');
  for (const [v, label] of options) s.append(Object.assign(el('option', null, label), { value: v }));
  s.value = value ?? options[0]?.[0] ?? '';
  return s;
}
const pform = () => el('form', 'parts-form');
function formActions(form, saveText, { onDelete } = {}) {
  const error = el('p', 'form-error');
  error.hidden = true;
  const save = Object.assign(el('button', 'btn btn-save', saveText), { type: 'submit' });
  const actions = el('div', 'work-actions');
  actions.append(error, save);
  if (onDelete) {
    const del = Object.assign(el('button', 'btn btn-ghost btn-delete', t('delete')), { type: 'button' });
    del.addEventListener('click', onDelete);
    actions.append(del);
  }
  form.append(actions);
  return { save, fail: (msg) => { error.textContent = msg; error.hidden = false; } };
}

// Add or change a part; "On hand" saves a count when it's changed.
function openPart(id) {
  const p = id ? partById(id) : null;
  const body = partsDialog(p ? p.name : t('addPart'), p?.number);
  const form = pform();
  const name = Object.assign(el('input'), { type: 'text', value: p?.name ?? '', required: true, placeholder: t('partNamePh') });
  const number = Object.assign(el('input'), { type: 'text', value: p?.number ?? '', placeholder: t('partNumberPh') });
  const group = selectOf(PART_GROUPS.map((g) => [g, t('partGroups')[g]]), p?.group ?? 'filter');
  const unit = selectOf([['each', t('unitEach')], ['gal', t('unitGal')]], p?.unit ?? 'each');
  const have = p ? onHand(p, receipts, serviceLog) : 0;
  const count = numberInput(p ? have : '');
  const min = numberInput(p?.min ?? '');
  const auto = selectOf([['', t('autoNone')], ...AUTO_USES.map((u) => [u, t('autoUses')[u]])], p?.autoUse ?? '');
  // Packs: how it's bought (drum, case…), in gallons or units.
  const packs = (p?.packs ?? []).map((x) => ({ ...x }));
  const packBox = el('div', 'pack-box');
  function drawPacks() {
    packBox.replaceChildren(...packs.map((x, i) => {
      const row = el('div', 'pack-row');
      const pn = Object.assign(el('input'), { type: 'text', value: x.name, placeholder: t('packNamePh') });
      const ps = numberInput(x.size);
      ps.placeholder = t('packSizePh');
      pn.addEventListener('input', () => { x.name = pn.value; });
      ps.addEventListener('input', () => { x.size = ps.value; });
      const rm = Object.assign(el('button', 'btn btn-ghost pack-rm', '×'), { type: 'button' });
      rm.setAttribute('aria-label', t('remove'));
      rm.addEventListener('click', () => { packs.splice(i, 1); drawPacks(); });
      row.append(pn, ps, rm);
      return row;
    }));
    const addPack = Object.assign(el('button', 'link-btn', t('addPack')), { type: 'button' });
    addPack.addEventListener('click', () => { packs.push({ name: '', size: '' }); drawPacks(); });
    packBox.append(addPack);
  }
  drawPacks();
  form.append(
    field(t('partName'), name), field(t('partNumber'), number), field(t('partGroup'), group), field(t('partUnit'), unit),
    field(p ? t('onHandCount') : t('onHandStart'), count),
    field(t('keepAtLeast'), min),
    field(t('packs'), packBox),
    field(t('autoUse'), auto),
  );
  if (p && !p.countAt) form.append(el('p', 'parts-hint', t('countHint')));
  if (p) form.append(...partBatches(p));
  const { save, fail } = formActions(form, t('save'), {
    onDelete: p ? async () => {
      if (!confirm(t('confirmArchive', p.name))) return;
      await setDoc(doc(db, 'parts', p.id), { archived: true, updatedAt: serverTimestamp() }, { merge: true });
      $('pdlg').close();
    } : null,
  });
  body.append(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!name.value.trim()) return fail(t('errPartName'));
    save.disabled = true;
    const data = {
      name: name.value.trim(),
      number: number.value.trim(),
      group: group.value,
      unit: unit.value,
      min: min.value === '' ? null : Number(min.value),
      autoUse: auto.value || null,
      packs: packs.filter((x) => x.name.trim() && Number(x.size) > 0).map((x) => ({ name: x.name.trim(), size: Number(x.size) })),
      updatedAt: serverTimestamp(),
    };
    // A changed (or first) number on hand is a count: stock starts from it.
    const counted = count.value !== '' && (!p || Number(count.value) !== have);
    if (counted) Object.assign(data, { countQty: Number(count.value), countAt: serverTimestamp() });
    const ref = p ? doc(db, 'parts', p.id) : doc(collection(db, 'parts'));
    if (!p) Object.assign(data, { id: ref.id, createdAt: serverTimestamp() });
    try {
      await setDoc(ref, data, { merge: true });
      $('pdlg').close();
    } catch (err) {
      save.disabled = false;
      fail(t('couldNotSave', err.message));
    }
  });
}

// A part's batches: what each receipt brought in and how much of it is left
// (oldest is used first), newest first.
function partBatches(p) {
  const held = (lot) => itemUses.filter((u) => u.receiptId === lot.receiptId && u.lineId === lot.lineId && ['auto', 'doubt', 'confirmed'].includes(u.status))
    .reduce((s, u) => s + (Number(u.qty) || 0), 0);
  const lots = stockLots(receipts).filter((lot) => lot.part === p.id).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, 8);
  if (!lots.length) return [];
  const box = el('div', 'batch-list');
  for (const lot of lots) {
    const left = Math.max(0, Math.round((lot.qty - held(lot)) * 100) / 100);
    const row = el('div', `batch-row${left ? '' : ' batch-empty'}`);
    row.append(
      el('span', 'batch-qty', `${qtyText(left)} of ${qtyText(lot.qty)} left`),
      el('span', 'batch-cost', lot.unitCost != null ? `${money(lot.unitCost)} ${p.unit === 'gal' ? '/ gal' : 'each'}` : ''),
      receiptChip(lot.receiptId, `${qtyText(lot.qty)} × ${p.name} · ${qtyText(left)} left`),
    );
    box.append(row);
  }
  return [el('div', 'section-title', 'Batches (oldest is used first)'), box];
}

// One kit: the parts a service uses on the trucks of one kit group.
function openKit(key, tag, label) {
  const lines = (kits[key]?.[tag] ?? []).map((l) => ({ ...l }));
  const body = partsDialog(t('kitTags')[tag], label);
  const form = pform();
  const box = el('div', 'kit-lines');
  const options = [['', t('choosePart')], ...activeParts().map((p) => [p.id, [p.name, p.number].filter(Boolean).join(' · ')])];
  function draw() {
    box.replaceChildren(...lines.map((l, i) => {
      const row = el('div', 'kit-line');
      const part = selectOf(options, l.part);
      const qty = numberInput(l.qty);
      part.addEventListener('change', () => { l.part = part.value; });
      qty.addEventListener('input', () => { l.qty = qty.value; });
      const rm = Object.assign(el('button', 'btn btn-ghost pack-rm', '×'), { type: 'button' });
      rm.setAttribute('aria-label', t('remove'));
      rm.addEventListener('click', () => { lines.splice(i, 1); draw(); });
      row.append(part, qty, rm);
      return row;
    }));
    const addLine = Object.assign(el('button', 'link-btn', t('addPartLine')), { type: 'button' });
    addLine.addEventListener('click', () => { lines.push({ part: '', qty: 1 }); draw(); });
    box.append(addLine);
  }
  draw();
  form.append(el('p', 'parts-hint', t('kitHint')), box);
  const { save, fail } = formActions(form, t('save'));
  body.append(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const clean = lines.filter((l) => l.part && Number(l.qty) > 0).map((l) => ({ part: l.part, qty: Number(l.qty) }));
    save.disabled = true;
    try {
      await setDoc(doc(db, 'meta', 'kits'), { [key]: { [tag]: clean } }, { merge: true });
      $('pdlg').close();
    } catch (err) {
      save.disabled = false;
      fail(t('couldNotSave', err.message));
    }
  });
}

// Shrinks a receipt photo to fit in a Firestore document (under ~700 KB).
async function shrinkPhoto(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  let quality = 0.7;
  let url = canvas.toDataURL('image/jpeg', quality);
  while (url.length > 700000 && quality > 0.3) { quality -= 0.15; url = canvas.toDataURL('image/jpeg', quality); }
  return url;
}

const savedVendors = () => {
  const counts = new Map();
  for (const r of receipts) if (r.vendor) counts.set(r.vendor, (counts.get(r.vendor) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([v]) => v);
};

// A receipt: photo, store, date, and its lines. A line is a stocked part
// (goes on the shelf) or anything else, charged to a truck or the shop.
// Lines the reader couldn't place show what it read and why; they stay on
// the receipt (adding nothing to stock) until someone picks where they go.
// A line has somewhere to go: the shelf, a truck, the shop, or (repair parts,
// labor, cores, returns the reader sorted) the pool the AI matches from.
const linePlaced = (l) => Boolean(l.part || l.to) || (!l.flags?.length && [...POOL_KINDS, 'credit'].includes(l.kind));

// The lines admin changed from what the reader read, as corrections docs.
function readingCorrections(before, after) {
  const truck = (l) => (l.vehicleId ? unitName(l.vehicleId) : l.for?.[0]?.name ?? null);
  const place = (l) => ({ part: l.part || null, kind: l.part ? 'stock' : lineKind(l), truck: truck(l), qty: Number(l.qty) || 0, price: l.price ?? null });
  const same = (a, b) => a.part === b.part && a.kind === b.kind && a.truck === b.truck && a.qty === b.qty && a.price === b.price;
  const base = { type: 'reading', vendor: after.vendor || before.vendor || null };
  const at = new Date().toISOString();
  const old = new Map((before.lines ?? []).map((l, i) => [l.id ?? `i${i}`, l]));
  const out = [];
  for (const l of after.lines) {
    const o = old.get(l.id);
    old.delete(l.id);
    if (o && same(place(o), place(l))) continue;
    out.push({ ...base, at, text: l.text || o?.text || '', partNumber: l.partNumber ?? o?.partNumber ?? null, before: o ? place(o) : null, after: place(l) });
  }
  for (const o of old.values()) out.push({ ...base, at, text: o.text ?? '', partNumber: o.partNumber ?? null, before: place(o), after: null });
  return out;
}

function openReceipt(id) {
  const r = id ? receipts.find((x) => x.id === id) : null;
  const body = partsDialog(r ? (r.vendor || t('receipt')) : t('newReceipt'), r ? dateText(r.date) : null);
  if (r?.note) body.append(el('p', 'receipt-note', t('buyerNote', r.note)));
  if (r) body.append(receiptDates(r), ...openLinesBox(r));
  const form = pform();
  const today = new Date().toLocaleDateString('en-CA');
  const state = {
    photo: null, // new photo (data URL)
    vendor: r?.vendor ?? '',
    lines: (r?.lines ?? [{ part: '', qty: '', price: '' }]).map((l, i) => ({ ...l, id: l.id ?? (r ? `i${i}` : null), packSize: 1, packQty: l.qty })),
  };

  // Photo: take one now, or see the saved one.
  const photoBox = el('div', 'receipt-photo');
  const fileInput = Object.assign(el('input'), { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const takeBtn = Object.assign(el('button', 'btn btn-ghost photo-btn', r?.hasPhoto ? t('retakePhoto') : t('takePhoto')), { type: 'button' });
  // The buyer's photo stays; only a receipt typed here can take one.
  takeBtn.hidden = Boolean(r && (r.source || r.uploadedBy || r.readAt));
  const preview = Object.assign(el('img', 'receipt-img'), { alt: t('receipt'), hidden: true });
  takeBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    takeBtn.disabled = true;
    try {
      state.photo = await shrinkPhoto(file);
      preview.src = state.photo;
      preview.hidden = false;
      takeBtn.textContent = t('retakePhoto');
    } catch (err) {
      showAppError(`Could not read the photo: ${err.message}`);
    } finally {
      takeBtn.disabled = false;
    }
  });
  if (r?.hasPhoto) {
    getDoc(doc(db, 'receiptPhotos', r.id)).then((snap) => {
      if (!state.photo && snap.exists()) { preview.src = snap.data().data; preview.hidden = false; }
    }).catch(() => {});
  }
  preview.addEventListener('click', () => { if (preview.src) window.open(preview.src, '_blank'); });
  photoBox.append(takeBtn, fileInput, preview);

  const date = Object.assign(el('input'), { type: 'date', required: true, max: today, value: r?.date ?? today });
  const time = Object.assign(el('input'), { type: 'time', value: r?.time ?? '' });
  const when = el('div', 'receipt-when');
  when.append(field(t('datesReceipt'), date), field(t('timeLabel'), time));
  const vendor = combo(state.vendor, (v) => { state.vendor = v; }, {
    options: savedVendors, placeholder: t('vendorPh'), newText: (v) => t('newVendor', v), emptyText: t('noVendorsYet'),
  });
  const vendorWrap = el('div', 'field');
  vendorWrap.append(el('span', null, t('vendor')), vendor.wrap);

  // Where a line goes: a stock part, a kind (repair parts go to the pool,
  // where the AI finds their repair), or a repair part for a known truck.
  const truckOptions = [...vehicles].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })).map((v) => [`truck:${v.id}`, v.name]);
  const kindOptions = ['part', 'labor', 'core', 'fee', 'supplies', 'tool', 'credit'].map((k) => [`kind:${k}`, t('kindOpt')[k]]);
  const partOptions = [['', t('choosePart')], ...activeParts().map((p) => [`part:${p.id}`, [p.name, p.number].filter(Boolean).join(' · ')]), ...kindOptions, ...truckOptions.map(([v, n]) => [v, t('forTruck', n)])];
  const linesBox = el('div', 'receipt-lines');
  const tax = numberInput(r?.tax ?? '');
  const feesNow = r?.feesTotal ?? (r?.fees ?? []).reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
  const fees = numberInput(feesNow || '', { step: '0.01' });
  const totalText = el('div', 'receipt-sum');
  const lineValue = (l) => (l.part ? `part:${l.part}` : l.to === 'truck' ? `truck:${l.vehicleId}`
    : linePlaced(l) ? `kind:${lineKind(l)}` : '');
  function updateTotal() {
    const sum = state.lines.reduce((s, l) => s + (Number(l.price) || 0), 0) + (Number(tax.value) || 0) + (Number(fees.value) || 0);
    totalText.textContent = t('receiptTotal', money(sum));
  }
  function drawLines() {
    linesBox.replaceChildren(...state.lines.map((l, i) => {
      const row = el('div', 'receipt-line');
      const what = selectOf(partOptions, lineValue(l));
      const part = () => partById(l.part);
      const text = Object.assign(el('input'), { type: 'text', value: l.text ?? '', placeholder: t('lineTextPh') });
      text.hidden = Boolean(l.part) || !lineValue(l);
      // Quantity, in packs when the part has them ("2 drums" = 110 gal).
      const qty = numberInput(l.packQty);
      qty.placeholder = t('qty');
      const packOptions = () => (part() ? [[1, part().unit === 'gal' ? 'gal' : t('unitEachShort')], ...(part().packs ?? []).map((p) => [p.size, `${p.name} (${p.size})`])] : [[1, t('unitEachShort')]]);
      const pack = selectOf(packOptions(), l.packSize);
      pack.hidden = !part()?.packs?.length && part()?.unit !== 'gal';
      const price = numberInput(l.price, { step: '0.01' });
      price.placeholder = t('linePrice');
      const sync = () => { l.qty = qty.value === '' ? '' : Number(qty.value) * Number(l.packSize || 1); };
      what.addEventListener('change', () => {
        const [type, ref] = what.value.split(':');
        const keepKind = [...POOL_KINDS, 'credit'].includes(l.kind) ? l.kind : 'part';
        Object.assign(l, type === 'part' ? { part: ref, kind: 'stock', to: 'stock', vehicleId: null }
          : type === 'truck' ? { part: null, kind: keepKind, to: 'truck', vehicleId: ref }
            : type === 'kind' ? { part: null, kind: ref, to: SHOP_KINDS.includes(ref) ? 'shop' : null, vehicleId: null }
              : { part: null, to: null, vehicleId: null });
        // A choice settles what the reader wasn't sure of.
        if (what.value) l.flags = [];
        l.packSize = 1;
        l.truckFrom = null;
        l.truckChoices = null;
        sync();
        drawLines();
      });
      text.addEventListener('input', () => { l.text = text.value; });
      qty.addEventListener('input', () => { l.packQty = qty.value; sync(); });
      pack.addEventListener('change', () => { l.packSize = Number(pack.value); sync(); });
      price.addEventListener('input', () => { l.price = price.value; updateTotal(); });
      const rm = Object.assign(el('button', 'btn btn-ghost pack-rm', '×'), { type: 'button' });
      rm.setAttribute('aria-label', t('remove'));
      rm.addEventListener('click', () => { state.lines.splice(i, 1); drawLines(); updateTotal(); });
      const nums = el('div', 'receipt-nums');
      nums.append(qty, pack, price, rm);
      // What the reader saw, and why it's waiting (until a choice is made).
      if (!linePlaced(l) && (l.flags?.length || l.text)) {
        row.classList.add('needs-choice');
        row.prepend(el('p', 'line-read', `${t('readAs')}: ${l.text}${l.partNumber ? ` (${l.partNumber})` : ''}`));
        if (l.flags?.length) row.append(el('p', 'need-missing', l.flags.map((f) => t('lineFlags')[f] ?? f).join(' · ')));
        if (l.suggestedPart && partById(l.suggestedPart)) row.append(el('p', 'line-for', t('maybePart', partById(l.suggestedPart).name)));
      }
      row.append(what, text, nums);
      if (l.for?.length) row.append(el('p', 'line-for', t('forTrucks', l.for.map((u) => u.name).join(', '))));
      return row;
    }));
    const addLine = Object.assign(el('button', 'link-btn', t('addLine')), { type: 'button' });
    addLine.addEventListener('click', () => { state.lines.push({ part: '', qty: '', price: '', packSize: 1, packQty: '' }); drawLines(); });
    linesBox.append(addLine);
  }
  drawLines();
  tax.addEventListener('input', updateTotal);
  updateTotal();

  fees.addEventListener('input', updateTotal);
  const feesField = field(t('feesLabel'), fees);
  if (r?.fees?.length) feesField.append(el('span', 'parts-hint', t('feesRead', r.fees.map((f) => `${f.label} ${money(f.amount)}`).join(', '))));
  form.append(photoBox, when, vendorWrap, el('div', 'section-title', t('lines')), linesBox, field(t('tax'), tax), feesField, totalText);
  const { save, fail } = formActions(form, t('saveReceipt'), {
    onDelete: r ? async () => {
      if (!confirm(t('confirmDeleteReceipt'))) return;
      const batch = writeBatch(db);
      batch.delete(doc(db, 'receipts', r.id));
      batch.delete(doc(db, 'receiptPhotos', r.id));
      await batch.commit();
      $('pdlg').close();
    } : null,
  });
  body.append(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Decided lines need a quantity; read lines still undecided are kept.
    const lines = state.lines.filter((l) => l.part || l.to || l.kind || l.flags?.length);
    const decided = lines.filter(linePlaced);
    if (!lines.length && r?.status !== 'waiting') return fail(t('errNoLines'));
    const bad = decided.find((l) => !(Number(l.qty) > 0));
    if (bad) return fail(t('errLineQty'));
    if (decided.some((l) => !l.part && !(l.text ?? '').trim())) return fail(t('errLineText'));
    save.disabled = true;
    const taxAmount = Number(tax.value) || 0;
    const feesAmount = Math.round((Number(fees.value) || 0) * 100) / 100;
    const total = lines.reduce((s, l) => s + (Number(l.price) || 0), 0) + taxAmount + feesAmount;
    const priceOf = (l) => (l.price === '' || l.price == null ? null : Number(l.price));
    // Each line's real cost: its price plus its share of tax and fees.
    const costs = landedCosts(lines.map((l) => ({ price: priceOf(l) })), taxAmount + feesAmount);
    const ref = r ? doc(db, 'receipts', r.id) : doc(collection(db, 'receipts'));
    const data = {
      id: ref.id,
      date: date.value,
      time: time.value || null,
      vendor: state.vendor.trim() ? canonicalName(state.vendor, savedVendors()) : '',
      lines: lines.map((l, i) => {
        const placed = linePlaced(l);
        return {
          id: l.id || Math.random().toString(36).slice(2, 10),
          part: l.part || null,
          kind: l.part ? 'stock' : lineKind(l),
          // The receipt's own wording is kept for lines the reader filled in.
          text: (l.part && !l.flags ? partById(l.part)?.name : l.text?.trim()) || partById(l.part)?.name || '',
          partNumber: l.partNumber ?? null,
          qty: Number(l.qty) || 0,
          price: priceOf(l),
          cost: costs[i],
          to: l.part ? 'stock' : l.to ?? null,
          vehicleId: l.to === 'truck' ? l.vehicleId : null,
          for: l.for?.length ? l.for : null,
          truckFrom: l.to === 'truck' || l.for?.length ? l.truckFrom ?? null : null,
          flags: placed ? [] : l.flags ?? [],
          suggestedPart: placed ? null : l.suggestedPart ?? null,
          truckChoices: placed ? null : l.truckChoices ?? null,
        };
      }),
      // Still waiting for a person while any read line has nowhere to go.
      status: r?.status === 'waiting' && !lines.length ? 'waiting' : lines.some((l) => !linePlaced(l)) ? 'review' : 'read',
      tax: tax.value === '' ? null : Number(tax.value),
      // The fees as read, unless admin changed the amount.
      fees: feesAmount === Math.round(feesNow * 100) / 100 && r?.fees ? r.fees : feesAmount ? [{ label: t('feesWord'), amount: feesAmount }] : [],
      feesTotal: feesAmount,
      total: Math.round(total * 100) / 100,
      // Who sent it comes from WhatsApp, the text or the upload; a receipt
      // typed here is admin's.
      ...(r ? {} : { uploadedBy: rememberedName() || null }),
      hasPhoto: Boolean(state.photo || r?.hasPhoto),
      updatedAt: serverTimestamp(),
      ...(r ? {} : { createdAt: serverTimestamp() }),
    };
    const batch = writeBatch(db);
    batch.set(ref, data, { merge: true });
    if (state.photo) batch.set(doc(db, 'receiptPhotos', ref.id), { data: state.photo });
    // What admin changed in what the AI read: the reader learns from it.
    if (r?.readAt) for (const c of readingCorrections(r, data)) batch.set(doc(collection(db, 'corrections')), c);
    try {
      await batch.commit();
      $('pdlg').close();
    } catch (err) {
      save.disabled = false;
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
        const brand = st?.entry?.tireBrands?.[pos];
        if (brand) tile.append(el('span', 'tire-note tire-brand', brand));
        g.append(tile);
      }
      return g;
    };
    row.append(side(axle.left), el('span', 'tire-gap'), side(axle.right));
    wrap.append(row);
  }
  return wrap;
}

// Brand of each tire changed: required, one box per tire. Each box is a
// creatable combobox: type or pick from the list, and a brand typed for the
// first time joins the list once the record is saved (the list is every
// brand already in the service log, most used first).
const savedBrands = () => savedValues((e) => Object.values(e.tireBrands ?? {}));

// Compare names ignoring case, extra spaces and accents ("hector" = "Héctor").
const plainName = (x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const sameName = (a, b) => plainName(a) === plainName(b);

// A typed value in the list's spelling ("michelin" -> "Michelin"); a new one
// tidied up (extra spaces, all-lowercase words capitalized).
function canonicalName(typed, list) {
  const clean = typed.trim().replace(/\s+/g, ' ');
  const known = list.find((x) => sameName(x, clean));
  if (known) return known;
  return clean === clean.toLowerCase() ? clean.replace(/(^|\s)(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase()) : clean;
}
const canonicalBrand = (typed, list = savedBrands()) => canonicalName(typed, list);

// Most-used-first list of the values in a service log field (tire brands, names).
function savedValues(valuesOf) {
  const counts = [];
  for (const e of serviceLog) {
    for (const raw of valuesOf(e)) {
      const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
      if (!name) continue;
      const c = counts.find((x) => sameName(x.name, name));
      if (c) c.n += 1; else counts.push({ name, n: 1 });
    }
  }
  return counts.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((c) => c.name);
}

// A creatable combobox: type, or pick from `options()`; a value typed for the
// first time joins the list once a record with it is saved.
function combo(value, onChange, { options, placeholder, newText, emptyText }) {
  const wrap = el('div', 'combo');
  const input = Object.assign(el('input'), { type: 'text', value, placeholder, autocomplete: 'off' });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  const toggle = Object.assign(el('button', 'combo-toggle', '▾'), { type: 'button', tabIndex: -1 });
  toggle.setAttribute('aria-label', placeholder);
  const list = el('div', 'combo-list');
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  const set = (v) => { input.value = v; onChange(v); };
  function draw() {
    const q = input.value.trim();
    const all = options();
    const matches = all.filter((x) => !q || plainName(x).includes(plainName(q)));
    list.replaceChildren();
    for (const x of matches) {
      const opt = Object.assign(el('button', 'combo-option', x), { type: 'button' });
      opt.setAttribute('role', 'option');
      opt.addEventListener('mousedown', (e) => e.preventDefault()); // keep the keyboard up
      opt.addEventListener('click', () => { set(x); close(); });
      list.append(opt);
    }
    if (q && !all.some((x) => sameName(x, q))) list.append(el('div', 'combo-new', newText(canonicalName(q, all))));
    if (!list.childElementCount) list.append(el('div', 'combo-new', emptyText));
  }
  function open() { draw(); list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
  function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); }
  input.addEventListener('focus', open);
  input.addEventListener('input', () => { onChange(input.value); open(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') { e.preventDefault(); close(); }
  });
  toggle.addEventListener('mousedown', (e) => e.preventDefault());
  toggle.addEventListener('click', () => { if (list.hidden) { input.focus(); open(); } else close(); });
  wrap.append(input, toggle, list);
  return { wrap, input };
}

const brandCombo = (value, onChange) => combo(value, onChange, {
  options: savedBrands, placeholder: t('brand'), newText: (b) => t('newBrand', b), emptyText: t('noBrandsYet'),
});

// "Logged by": the names already in the log, most used first; this phone's
// last name is filled in.
const savedNames = () => savedValues((e) => [e.loggedBy]);
function loggedByField() {
  const state = { value: rememberedName() };
  const c = combo(state.value, (v) => { state.value = v; }, {
    options: savedNames, placeholder: t('yourName'), newText: (n) => t('newName', n), emptyText: t('noNamesYet'),
  });
  const wrap = el('div', 'field wide');
  wrap.append(el('span', null, t('loggedBy')), c.wrap);
  // The name as saved: in the list's spelling when it's someone already there.
  return { wrap, value: () => (state.value.trim() ? canonicalName(state.value, savedNames()) : '') };
}

function brandFields(order, nameOf, brands) {
  const box = el('div', 'tire-brands');
  if (!order.length) return box;
  box.append(el('div', 'section-title', t('tireBrandsTitle')));
  const inputs = order.map((pos) => {
    const combo = brandCombo(brands[pos] ?? '', (v) => { brands[pos] = v; });
    combo.input.dataset.pos = pos;
    const row = el('div', 'tire-brand-row');
    row.append(el('span', 'tire-brand-pos', nameOf(pos, getLang())), combo.wrap);
    box.append(row);
    return combo.input;
  });
  // Usually every new tire is the same brand: one tap copies the first box.
  if (order.length > 1) {
    const same = Object.assign(el('button', 'link-btn', t('sameForAll')), { type: 'button' });
    same.addEventListener('click', () => {
      const first = inputs[0].value.trim();
      if (!first) { inputs[0].focus(); return; }
      inputs.forEach((i) => { i.value = first; brands[i.dataset.pos] = first; });
    });
    box.append(same);
  }
  return box;
}
// Tires left without a brand (the form won't save until each has one).
const missingBrands = (order, brands) => order.filter((p) => !(brands[p] ?? '').trim());
const withBrands = (order, nameOf, brands) => order.map((p) => `${nameOf(p, 'en')} (${brands[p]})`).join(', ');
// Brands as saved: in the list's spelling when it's a known brand.
const savedTireBrands = (order, brands) => {
  const list = savedBrands();
  return Object.fromEntries(order.map((p) => [p, canonicalBrand(brands[p], list)]));
};

// A truck's tire drawing, with its own steer / drive limits.
const truckTireDiagram = (v, opts = {}) => tireDiagram(v.tires, {
  ...opts,
  layout: truckLayout(),
  nameOf: truckPositionName,
  isWorn: (pos, st) => st?.miles != null && st.miles >= limitFor(pos, truckTireLimits()),
});

// Truck page: when the batteries were last replaced.
function batterySection(v) {
  const box = el('section', 'truck-batteries');
  const last = (visitsByTruck.get(v.id) ?? []).filter((e) => e.type === 'batteries')
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.miles ?? 0) - (a.miles ?? 0))[0];
  box.append(el('h3', 'section-title', t('batteriesSection')));
  box.append(el('p', 'item-meta', last
    ? t('batteriesLast', dateText(last.date), last.miles != null ? fmt.format(Math.round(last.miles)) : null, last.batteries)
    : t('batteriesNone')));
  return box;
}

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
  work = { kind: 'trailer', trailerId, tires: new Set(), brands: {}, repair: false };
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
      }),
      brandFields(TIRE_POSITIONS.filter((p) => work.tires.has(p)), positionName, work.brands));
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
  const who = loggedByField();
  const wide = (f) => { f.classList.add('wide'); return f; };
  const details = el('div', 'work-details');
  details.append(wide(field(t('date'), date)), wide(field(t('note'), note)), who.wrap);
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
    const changed = TIRE_POSITIONS.filter((p) => work.tires.has(p));
    if (missingBrands(changed, work.brands).length) {
      tires.querySelector(`input[data-pos="${missingBrands(changed, work.brands)[0]}"]`)?.focus();
      return fail(t('errBrand'));
    }
    if (date.value > today) return fail(t('errFuture'));
    save.disabled = true;
    save.textContent = t('saving');
    const loggedBy = who.value();
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
      batch.set(ref, {
        ...common, tires: order, partsUsed: tireParts(order, partsList, { trailer: true }),
        tireBrands: savedTireBrands(order, work.brands),
        itemName: `Tires changed: ${withBrands(order, positionName, savedTireBrands(order, work.brands))}`,
      });
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
      const matching = startMatchingSoon();
      showUndo(t('saved', c.name, summary), async () => {
        matching.cancel();
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

// New work starts the matching run (twilio/start-matching.js), so what was
// bought for it is tied to it in a minute or two instead of the next hourly
// run. Sent once the Undo has passed; nothing is sent if it's undone.
const START_MATCHING_URL = 'https://receipts-4564.twil.io/start-matching';
function startMatchingSoon() {
  const timer = setTimeout(() => {
    // A plain form post needs no permission check from the browser; the
    // answer isn't needed (the hourly run still catches anything missed).
    fetch(START_MATCHING_URL, { method: 'POST', mode: 'no-cors', body: new URLSearchParams({ app: 'aslog' }) }).catch(() => {});
  }, 12000);
  return { cancel: () => clearTimeout(timer) };
}

// A message bar with an Undo button that disappears after 10 seconds.
let undoTimer;
// A message at the bottom of the screen, with Undo when `undo` is given.
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
  bar.replaceChildren(el('span', null, message), ...(undo ? [btn] : []));
  // An open popup sits above the page, so the bar goes inside it.
  const host = [$('pdlg'), $('work'), $('truck'), $('schedule')].find((d) => d.open) ?? document.body;
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
      renderAnalytics();
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
        // Just-saved entries count right away (estimated time until the server's).
        const e = d.data({ serverTimestamps: 'estimate' });
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
    onSnapshot(collection(db, 'parts'), (snap) => {
      partsList = snap.docs.map((d) => ({ ...d.data({ serverTimestamps: 'estimate' }), id: d.id }));
      renderParts();
    }, (err) => console.error(err)),
    onSnapshot(doc(db, 'meta', 'kits'), (snap) => {
      kits = snap.data() ?? {};
      renderParts();
    }, (err) => console.error(err)),
    onSnapshot(collection(db, 'receipts'), (snap) => {
      receipts = snap.docs.map((d) => {
        const r = d.data({ serverTimestamps: 'estimate' });
        return { ...r, id: d.id, createdMs: r.createdAt?.toMillis?.() ?? 0 };
      });
      renderParts();
      renderAnalytics();
    }, (err) => console.error(err)),
    onSnapshot(collection(db, 'itemUses'), (snap) => {
      itemUses = snap.docs.map((d) => ({ ...d.data({ serverTimestamps: 'estimate' }), id: d.id }));
      renderParts();
      renderAnalytics();
    }, (err) => console.error(err)),
    onSnapshot(doc(db, 'meta', 'aiMemory'), (snap) => {
      aiMemory = snap.data() ?? {};
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
  const tab = wantedTab();
  if (TABS.includes(tab) && !roleUnlocked(roleOfTab(tab))) askPassword(roleOfTab(tab));
  showTab();
  render();
});
$('admin-lock').addEventListener('submit', (e) => {
  e.preventDefault();
  const typed = $('admin-pass').value.trim().toLowerCase();
  // On the Analytics page the office password works as well as admin's.
  const locks = [ROLE_LOCKS[lockRole], ...(ANALYTICS_PAGE && lockRole === 'admin' ? [ANALYTICS_LOCK] : [])].filter(Boolean);
  const lock = locks.find((l) => typed === l.password.toLowerCase());
  if (!lock) {
    $('admin-pass-error').hidden = false;
    $('admin-pass').select();
    return;
  }
  try { localStorage.setItem(lock.key, 'yes'); } catch { /* asked again next time */ }
  $('admin-lock').close('ok');
  showTab();
  render();
});
$('admin-pass-cancel').addEventListener('click', () => $('admin-lock').close());
// Closed without the password (Cancel or Esc): back to where they were.
$('admin-lock').addEventListener('close', () => {
  // The Analytics page without the password: back to the app's start.
  if (ANALYTICS_PAGE && !roleUnlocked('admin')) { location.href = '/'; return; }
  if (!roleUnlocked(lockRole)) history.replaceState(null, '', location.pathname + location.search + lastAllowedHash);
  lockRole = null;
  showTab();
  render();
});
for (const b of document.querySelectorAll('#lang button')) {
  b.addEventListener('click', () => { setLang(b.dataset.lang); renderRoleSwitch(); render(); });
}
$('role-current').addEventListener('click', () => {
  const open = $('role-switch').classList.toggle('open');
  $('role-current').setAttribute('aria-expanded', String(open));
});
for (const b of document.querySelectorAll('#role-menu button')) b.addEventListener('click', () => pickRole(b.dataset.role));
// A tap anywhere else closes the phone menu.
document.addEventListener('click', (e) => {
  if (!$('role-switch').contains(e.target)) { $('role-switch').classList.remove('open'); $('role-current').setAttribute('aria-expanded', 'false'); }
});
$('tr-search').addEventListener('input', renderTrailers);
for (const th of document.querySelectorAll('th[data-trsort]')) {
  th.addEventListener('click', () => {
    trSortDir = trSortKey === th.dataset.trsort ? -trSortDir : 1;
    trSortKey = th.dataset.trsort;
    renderTrailers();
  });
}
$('log-period').addEventListener('change', () => { applyLogPeriod(); renderLog(); });
$('an-unit').addEventListener('change', () => saveAnSettings({ unit: $('an-unit').value }));
for (const b of $('an-scope').querySelectorAll('button')) b.addEventListener('click', () => saveAnSettings({ scope: b.dataset.scope }));
for (const b of $('an-modes').querySelectorAll('button')) b.addEventListener('click', () => saveAnSettings({ mode: b.dataset.mode }));
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
if (ANALYTICS_PAGE) {
  document.body.classList.add('page-analytics');
  document.title = 'Analytics · aslog.dev';
  $('an-page-link').hidden = true;
  $('an-home').hidden = false;
}
if (TABS.includes(wantedTab()) && !roleUnlocked(roleOfTab(wantedTab()))) askPassword(roleOfTab(wantedTab()));
showTab();
$('t-close').addEventListener('click', () => $('truck').close());
$('s-close').addEventListener('click', () => $('schedule').close());
$('schedule').addEventListener('close', () => { openGroupKey = null; });
$('schedule').addEventListener('click', (e) => { if (e.target === $('schedule')) $('schedule').close(); });
$('truck').addEventListener('close', () => { openTruckId = null; openTrailerId = null; });
for (const b of document.querySelectorAll('#shop-side button')) b.addEventListener('click', () => setShopSide(b.dataset.side));
for (const b of document.querySelectorAll('#parts-side button')) b.addEventListener('click', () => setPartsSide(b.dataset.side));
$('p-close').addEventListener('click', () => $('pdlg').close());
$('pdlg').addEventListener('click', (e) => { if (e.target === $('pdlg')) $('pdlg').close(); });
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
