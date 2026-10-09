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
import { dateText, getLang, setLang, t } from './i18n.js';
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
let serviceLog = []; // serviceLog docs: visits (services and repairs) and duty changes
let visitsByTruck = new Map(); // vehicleId -> that truck's serviceLog entries
let trailers = []; // trailers docs
let trSortKey = 'lastReportedAt'; // most recently reported first
let trSortDir = -1;
let openTruckId = null; // truck shown in the detail dialog
let work = null; // the open "Log work" form ({ vehicleId, jobs, extra, unticked, repair, days })
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

// Trucks that haven't reported in a week are shown dimmed. Local trucks
// aren't in Samsara, so they never report.
function isQuiet(v) {
  if (v.local) return false;
  return !v.lastReportedAt || Date.now() - Date.parse(v.lastReportedAt) > 7 * DAY_MS;
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
  return {
    ...v, rows, next, shop, faults, oldFaults, here, quiet, nextRank: rank * 10 + Math.max(-5, Math.min(5, next?.urgency ?? 5)),
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
  { id: 'overdue', label: 'Overdue', test: (v) => v.next?.status === 'overdue' },
  { id: 'soon', label: 'Due soon', test: (v) => v.next?.status === 'soon' },
  { id: 'out', label: 'Out of service', test: (v) => Boolean(v.shop) },
  { id: 'quiet', label: 'No signal 3+ days', test: (v) => !v.shop && v.quiet != null && v.quiet >= QUIET_DAYS },
];

function statusFilter(counts) {
  // "Out of service" and "No signal" only show when they apply (or are selected).
  const shown = TRUCK_FILTERS.filter((f) => !['out', 'quiet'].includes(f.id) || counts[f.id] || truckFilter === f.id);
  const bar = el('div', 'status-filter');
  bar.style.setProperty('--n', shown.length);
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Show trucks');
  for (const f of shown) {
    const b = el('button', `sf-${f.id}${counts[f.id] ? ' has' : ''}${truckFilter === f.id ? ' active' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(truckFilter === f.id));
    b.append(el('span', 'sf-n', fmt.format(counts[f.id])), el('span', 'sf-label', f.label));
    b.addEventListener('click', () => { truckFilter = f.id; render(); });
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
  $('summary').replaceChildren(statusFilter(counts));

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
  renderSchedules();
  renderLog();
  renderTrailers();
  renderShop();
}

// ---- Trailers tab --------------------------------------------------------

const isMoving = (c) => (c.speedMph ?? 0) >= 3;

function renderTrailers() {
  if (currentTab() !== 'trailers') return;
  const q = $('tr-search').value.trim().toLowerCase();
  const filter = $('tr-filter').value;
  const matchesFilter = (c) => filter === 'all'
    || (filter === 'moving' && isMoving(c))
    || (filter === 'parked' && !isMoving(c) && !isQuiet(c))
    || (filter === 'quiet' && isQuiet(c));

  const visible = trailers
    .filter((c) => !q || [c.name, c.location, c.trackerModel, c.trackerSerial].join(' ').toLowerCase().includes(q))
    .filter(matchesFilter)
    .sort((a, b) => {
      const x = a[trSortKey];
      const y = b[trSortKey];
      if (x == null || x === '') return 1;
      if (y == null || y === '') return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * trSortDir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * trSortDir;
    });

  const moving = trailers.filter(isMoving).length;
  const quiet = trailers.filter(isQuiet).length;
  $('tr-summary').replaceChildren(
    chip(`${visible.length} trailers`, true),
    chip(`${moving} moving`),
    chip(`${trailers.length - moving - quiet} parked`),
    chip(`${quiet} quiet 7+ days`, false, quiet ? 'chip-soon' : ''),
  );

  $('tr-rows').replaceChildren(...visible.map((c) => {
    const tr = el('tr');
    if (isQuiet(c)) tr.className = 'quiet';
    const loc = el('td', 'wrap-cell');
    if (c.latitude != null && c.longitude != null) {
      const a = el('a', null, c.location || `${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)}`);
      Object.assign(a, {
        href: `https://www.google.com/maps?q=${c.latitude},${c.longitude}`,
        target: '_blank',
        rel: 'noopener',
      });
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
    ? 'No trailers match.'
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
  const trucks = new Set(services.map((e) => e.vehicleId)).size;
  $('log-summary').textContent = [
    services.length && `${plural(services.length, 'service')} on ${plural(trucks, 'truck')}`,
    dutyChanges && plural(dutyChanges, 'duty cycle change'),
  ].filter(Boolean).join(' · ');
  $('log-empty').hidden = rows.length > 0;
  $('log-rows').closest('.table-wrap').hidden = rows.length === 0;
  $('log-empty').textContent = serviceLog.length
    ? 'No services match these filters.'
    : 'No services logged yet. Open a truck on the Trucks tab and use "Mark done".';

  $('log-rows').replaceChildren(...rows.map((e) => {
    const tr = el('tr');
    const unitCell = el('td', 'strong');
    const link = el('button', 'link-btn', e.vehicleName || e.vehicleId);
    link.type = 'button';
    link.addEventListener('click', () => {
      if (vehicles.some((v) => v.id === e.vehicleId)) openTruck(e.vehicleId);
    });
    unitCell.append(link);
    const service = el('td', 'wrap-cell', e.itemName || e.itemId);
    if (e.type === 'duty') service.prepend(el('span', 'badge badge-auto', 'Auto'), ' ');
    if (e.type === 'repair') service.prepend(el('span', 'badge badge-repair', 'Repair'), ' ');
    const done = visitServices(e).map(itemNameFor).filter(Boolean);
    if (done.length) service.append(el('div', 'item-meta', `Marked done: ${done.join(', ')}`));
    const extra = [e.cost != null && `Cost $${fmt.format(e.cost)}`, e.loggedBy && `Logged by ${e.loggedBy}`].filter(Boolean);
    if (extra.length) service.append(el('div', 'item-meta', extra.join(' · ')));
    if (e.note) service.append(el('div', 'item-meta show-sm', `"${e.note}"`));
    tr.append(
      el('td', null, e.date ? niceDate(e.date) : 'Not written'),
      unitCell,
      service,
      el('td', 'num', e.miles == null ? '—' : fmt.format(e.miles)),
      el('td', 'num hide-sm', e.hours == null ? '—' : fmt.format(e.hours)),
      el('td', 'wrap-cell muted-cell hide-sm', e.note || ''),
    );
    return tr;
  }));
}

// ---- Schedules tab ---------------------------------------------------------

// The shop view is the main page; the rest is the admin side.
const TABS = ['shop', 'trucks', 'trailers', 'schedules', 'log'];

function currentTab() {
  const tab = location.hash.slice(1);
  return TABS.includes(tab) ? tab : 'shop';
}

function showTab() {
  const tab = currentTab();
  for (const x of TABS) $(`${x}-view`).hidden = x !== tab;
  const shop = tab === 'shop';
  $('admin-nav').hidden = shop;
  $('shop-top').hidden = !shop;
  for (const a of document.querySelectorAll('.tabs a')) {
    a.classList.toggle('active', a.dataset.tab === tab);
    a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false');
  }
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
  for (const [id, key] of [['company-name', 'companyName'], ['company-usdot', 'usdot']]) {
    if (document.activeElement !== $(id)) $(id).value = savedSettings[key] ?? '';
  }
  const defs = assignments?.settings ?? [];
  $('fleet-setup').hidden = defs.length === 0;
  const current = settings();
  // Collapsed, the box lists the current answers so it's clear what's set here.
  $('setup-summary').textContent = defs
    .map((d) => d.short?.[current[d.id] ? 'on' : 'off'] ?? `${d.label}: ${current[d.id] ? 'yes' : 'no'}`)
    .join(' · ');

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
  // Groups with trucks first, then the rest.
  return groups.sort((a, b) => (b.trucks.length > 0) - (a.trucks.length > 0));
}

function groupEngine(g) {
  return g.schedules.map((id) => schedules.get(id)).find((s) => s?.category === 'engine');
}

function renderSchedules() {
  if (currentTab() !== 'schedules' && !openGroupKey) return;
  renderSetup();
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
  if (!$('schedule').open) $('schedule').showModal();
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

function chip(text, strong = false, extraClass = '') {
  return el('span', ['chip', strong && 'chip-strong', extraClass].filter(Boolean).join(' '), text);
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

// Truck number plus small flags from Samsara: lamps, at the shop, no signal.
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

function signalBadges(v, { short = false } = {}) {
  const out = [];
  for (const lamp of v.faults?.lamps ?? []) {
    out.push(el('span', `sig sig-${lamp === 'stop' ? 'stop' : 'lamp'}`, short && lamp !== 'stop' ? '⚠' : lampName(lamp)));
  }
  if (v.here) out.push(el('span', 'sig sig-here', t('atShop')));
  if (v.quiet != null && v.quiet >= QUIET_DAYS && !v.shop) out.push(el('span', 'sig sig-quiet', short ? `📡 ${v.quiet}d` : t('noSignal', v.quiet)));
  return out;
}

// Lamps and the codes that matter, for the truck popup and the Log work form.
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
  if (f.time) box.append(el('p', 'item-meta', `Samsara · ${timeAgo(f.time)}`));
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
    milesCell,
    nextCell(v),
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
  if (!$('truck').open) $('truck').showModal();
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

function renderTruck(v) {
  if (!v) { $('truck').close(); return; }
  $('t-title').textContent = v.name;
  $('t-sub').textContent = [
    [v.year, titleCase(v.make || ''), titleCase(v.model || '')].filter(Boolean).join(' '),
    v.odometerMiles != null && `${fmt.format(v.odometerMiles)} mi`,
  ].filter(Boolean).join(' · ');

  const body = $('t-body');
  body.replaceChildren();
  const logBtn = el('button', 'btn btn-log', 'Log work');
  logBtn.type = 'button';
  logBtn.addEventListener('click', () => openWork(v.id));
  const pdfBtn = el('button', 'btn btn-ghost btn-pdf', 'Download maintenance record (PDF)');
  pdfBtn.type = 'button';
  pdfBtn.addEventListener('click', () => exportTruck(v, pdfBtn));
  body.append(logBtn, pdfBtn);
  if (v.shop) body.append(shopBanner(v));
  const where = [v.here ? t('atShop') : v.location?.address, v.quiet != null && v.quiet >= QUIET_DAYS ? t('noSignal', v.quiet) : null].filter(Boolean);
  if (where.length) body.append(el('p', 'muted truck-where', `📍 ${where.join(' · ')}`));
  const fb = faultsBox(v);
  if (fb) body.append(fb);
  if (v.local) {
    body.append(el('p', 'muted', 'Local truck: not in Samsara, so its miles only change when a service is logged.'));
  }
  if (!v.rows.length) {
    body.append(el('p', 'muted', v.scheduleIds?.length
      ? 'Loading… If this stays empty, the next sync will set it up.'
      : v.local
        ? 'No maintenance schedule yet. Add its year, make and model to apply one. Its service history is in the Log tab and the PDF.'
        : 'No maintenance schedule matches this truck.'));
    if (!v.shop) body.append(shopButton(v));
    return;
  }

  // 1. What needs doing, most urgent first.
  const attention = v.rows.filter((r) => r.status === 'overdue' || r.status === 'soon');
  const todo = el('section', 'todo');
  todo.append(el('h3', 'section-title', attention.length ? `Needs attention (${attention.length})` : 'Nothing due'));
  if (!attention.length) todo.append(el('p', 'muted', 'All services are up to date.'));
  attention.forEach((r) => todo.append(itemRow(v, r, true)));
  body.append(todo);

  // 2. Everything else, grouped by schedule, behind one tap.
  const rest = v.rows.filter((r) => !attention.includes(r));
  const all = el('details', 'all-services');
  all.append(el('summary', 'section-title', `All other services (${rest.length})`));
  for (const scheduleId of v.scheduleIds) {
    const schedule = schedules.get(scheduleId);
    const items = rest.filter((r) => r.schedule.id === scheduleId);
    if (!schedule || !items.length) continue;
    const section = el('section', 'sched');
    const head = el('div', 'sched-head');
    const duty = v.rows.find((x) => x.schedule.id === scheduleId)?.duty;
    const h3 = el('h3');
    h3.append(categoryTag(schedule), el('span', null, duty ? `${schedule.name} · ${dutyLabel(schedule.dutyModel, duty)}` : schedule.name));
    head.append(h3);
    const link = el('a', 'muted', 'Manual');
    Object.assign(link, { href: schedule.sourceUrl, target: '_blank', rel: 'noopener' });
    head.append(link);
    section.append(head);
    items.forEach((r) => section.append(itemRow(v, r)));
    all.append(section);
  }
  body.append(all);

  // 3. How the truck is used (duty cycle), compact.
  const models = truckDutyModels(v);
  if (models.length) body.append(dutySection(v, models));
  if (!v.shop) body.append(shopButton(v));
  if (v.vin) body.append(el('p', 'muted footnote', `VIN ${v.vin}`));
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

function itemRow(v, r, showSchedule = false) {
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
  if (r.status !== 'as-needed') {
    // Opens "Log work" with this item ticked, so every save goes through one form.
    const btn = el('button', 'btn btn-done', 'Mark done');
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
// a tap away from "Log work". English / Spanish.

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

function dueLine(r) {
  const line = el('div', `due-line due-${r.status}`);
  const text = el('div', 'due-text');
  text.append(el('span', 'due-name', r.item.name), el('span', 'due-when', dueWhen(r)));
  if (r.last?.source === 'baseline') text.append(el('span', 'due-note', `(${t('noRecord')})`));
  line.append(statusDot(r.status), text);
  return line;
}

function renderShop() {
  if (currentTab() !== 'shop') return;
  for (const b of document.querySelectorAll('#lang button')) b.classList.toggle('active', b.dataset.lang === getLang());
  $('admin-link').textContent = t('admin');
  // Listed: anything due, out of service, or a STOP lamp. Order: STOP lamp,
  // then parked at the shop, out of service, overdue, most urgent.
  const flag = (x) => Number(Boolean(x));
  const trucks = vehicles.map(withMaintenance)
    .map((v) => ({ v, due: v.rows.filter(DUE) }))
    .filter(({ v, due }) => v.shop || due.length || v.faults?.stop)
    .sort((a, b) => flag(b.v.faults?.stop) - flag(a.v.faults?.stop)
      || flag(b.v.here) - flag(a.v.here)
      || flag(b.v.shop) - flag(a.v.shop)
      || flag(b.due.some((r) => r.status === 'overdue')) - flag(a.due.some((r) => r.status === 'overdue'))
      || (a.due[0]?.urgency ?? 0) - (b.due[0]?.urgency ?? 0));

  $('shop-title').textContent = t('shopTitle');
  $('shop-count').textContent = vehicles.length ? (trucks.length ? t('shopCount', trucks.length) : t('shopEmpty')) : '';
  $('shop-cards').replaceChildren(...trucks.map(({ v, due }) => {
    const card = el('button', `shop-card${due.some((r) => r.status === 'overdue') || v.faults?.stop ? ' has-overdue' : ''}`);
    card.type = 'button';
    const head = el('div', 'shop-card-head');
    head.append(el('span', 'shop-truck', v.name), el('span', 'shop-miles', v.odometerMiles == null ? '' : `${fmt.format(v.odometerMiles)} mi`));
    card.append(head);
    const badges = signalBadges(v);
    if (badges.length) {
      const row = el('div', 'shop-signals');
      row.append(...badges);
      card.append(row);
    }
    if (v.shop) card.append(el('div', 'shop-oos', `${t('outOfService')}${v.shop.reason ? ` · ${v.shop.reason}` : ''}`));
    // The codes that matter (a STOP lamp's code first), then what's due.
    (v.faults?.major ?? []).slice(0, 2).forEach((c) => card.append(el('div', 'fault-line', `⚠ ${codeText(c)}`)));
    due.slice(0, 3).forEach((r) => card.append(dueLine(r)));
    if (due.length > 3) card.append(el('div', 'due-more', t('more', due.length - 3)));
    card.append(el('div', 'shop-cta', `${t('logWork')} →`));
    card.addEventListener('click', () => openWork(v.id));
    return card;
  }));
  $('shop-other').textContent = t('anotherTruck');
}

// ---- Log work ----------------------------------------------------------------
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
  work = { vehicleId, jobs: new Set(), extra: new Set(keys), unticked: new Set(), repair: false, days: null };
  buildWork();
  if (!$('work').open) $('work').showModal();
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
  const v = workTruck();
  $('w-close').textContent = t('close');
  $('w-title').textContent = v ? `${t('logWork')} · ${v.name}` : t('logWork');
  $('w-sub').textContent = v
    ? [[v.year, titleCase(v.make || ''), titleCase(v.model || '')].filter(Boolean).join(' '), v.odometerMiles != null && `${fmt.format(v.odometerMiles)} mi`].filter(Boolean).join(' · ')
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

  // 1. What's due on this truck: unticked; tap each one that was done.
  const dueBox = el('div', 'work-due');
  // 2. Shop jobs and repairs.
  const jobs = el('fieldset', 'work-jobs');
  // 3. Everything the save marks done (live list).
  const marks = el('div', 'work-marks');

  function refresh() {
    const keys = workKeys(v);
    const due = v.rows.filter(DUE);
    dueBox.replaceChildren();
    if (due.length) {
      dueBox.append(el('div', 'section-title', t('dueHere')), el('p', 'muted', t('dueHint')));
      for (const r of due) {
        const row = checkRow(r.item.name, keys.includes(r.key), (on) => {
          if (on) { work.extra.add(r.key); work.unticked.delete(r.key); } else { work.extra.delete(r.key); work.unticked.add(r.key); }
          refresh();
        }, [dueWhen(r), r.last?.source === 'baseline' && `(${t('noRecord')})`].filter(Boolean).join(' '), `due-${r.status}`);
        dueBox.append(row);
      }
    }
    marks.replaceChildren(el('div', 'section-title', t('marksDone')));
    if (!keys.length) marks.append(el('p', 'muted', work.jobs.size ? t('nothingOnSchedule') : t('tickAJob')));
    for (const k of workKeys(v, { includeUnticked: true })) {
      marks.append(checkRow(itemNameFor(k) ?? k, !work.unticked.has(k), (on) => {
        if (on) work.unticked.delete(k); else work.unticked.add(k);
        refresh();
      }));
    }
    const shown = workKeys(v, { includeUnticked: true });
    const others = v.rows.filter((r) => !shown.includes(r.key));
    if (others.length) {
      const add = el('select', 'add-item');
      add.append(Object.assign(el('option', null, t('addService')), { value: '' }));
      others.forEach((r) => add.append(Object.assign(el('option', null, r.item.name), { value: r.key })));
      add.addEventListener('change', () => { if (add.value) { work.extra.add(add.value); work.unticked.delete(add.value); refresh(); } });
      marks.append(add);
    }
    const n = keys.length + (work.repair ? 1 : 0);
    save.textContent = n ? t('saveCount', n, v.name) : t('save');
  }

  jobs.append(el('legend', 'section-title', t('whatDone')));
  for (const j of JOBS) {
    jobs.append(checkRow(jobLabel(j), work.jobs.has(j.id), (on) => {
      if (on) work.jobs.add(j.id); else work.jobs.delete(j.id);
      refresh();
    }, jobHint(j)));
  }
  const repairBox = el('div', 'repair-box');
  const repairText = Object.assign(el('textarea'), { rows: 2, placeholder: t('repairPlaceholder') });
  const cost = Object.assign(el('input'), { type: 'number', min: 0, step: '0.01', inputMode: 'decimal', placeholder: t('optional') });
  repairBox.append(field(t('repair'), repairText), field(t('cost'), cost));
  // Which of the truck's fault codes the repair fixed (saved with the repair).
  const fixedCodes = new Set();
  if (v.faults?.major.length) {
    const box = el('div', 'fixed-codes');
    box.append(el('div', 'section-title', t('fixedCodes')));
    v.faults.major.forEach((c) => box.append(checkRow(codeText(c), false, (on) => {
      if (on) fixedCodes.add(codeId(c)); else fixedCodes.delete(codeId(c));
    })));
    repairBox.append(box);
  }
  repairBox.hidden = !work.repair;
  jobs.append(checkRow(t('repairOther'), work.repair, (on) => {
    work.repair = on;
    repairBox.hidden = !on;
    if (on) repairText.focus();
    refresh();
  }));
  jobs.append(repairBox);

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
  details.append(field(t('note'), note), field(t('loggedBy'), who));

  const error = el('p', 'form-error');
  error.hidden = true;
  const cancel = Object.assign(el('button', 'btn btn-ghost btn-cancel', t('cancel')), { type: 'button' });
  cancel.addEventListener('click', () => $('work').close());
  const faultBox = faultsBox(v, { showMinor: false });
  form.append(...(faultBox ? [faultBox] : []), dueBox, jobs, marks, details, error, save, cancel);
  body.append(form);
  refresh();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fail = (msg) => { error.textContent = msg; error.hidden = false; error.scrollIntoView({ block: 'nearest' }); };
    const keys = workKeys(v);
    const m = Number(miles.value);
    const repair = repairText.value.trim();
    // Catch typos before they're saved.
    if (!keys.length && !work.jobs.size && !work.repair) return fail(t('errTick'));
    if (work.repair && !repair) return fail(t('errRepair'));
    if (date.value > today) return fail(t('errFuture'));
    if (!v.local && v.odometerMiles != null && m > v.odometerMiles + 500) return fail(t('errTooHigh', fmt.format(v.odometerMiles)));
    // Back-dated work: compare with what Samsara recorded around that day.
    const off = !v.local && milesSource === 'typed' && milesMismatch(work.days, date.value, m);
    if (off && !confirm(t('confirmSamsara', v.name, off.lo === off.hi ? fmt.format(off.lo) : `${fmt.format(off.lo)}–${fmt.format(off.hi)}`,
      dateText(date.value), fmt.format(m)))) return;
    const older = v.rows.filter((r) => keys.includes(r.key) && r.last?.source === 'done' && m < r.last.miles);
    if (older.length && !confirm(t('confirmOlder', older.map((r) => r.item.name).join(', '), fmt.format(older[0].last.miles)))) return;

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
    if (keys.length || work.jobs.size) {
      const ref = doc(collection(db, 'serviceLog'));
      batch.set(ref, { ...common, services: keys, itemName: workSummary(v, keys) });
      refs.push(ref);
    }
    if (work.repair) {
      const ref = doc(collection(db, 'serviceLog'));
      batch.set(ref, {
        ...common, type: 'repair', services: [], itemName: repair, cost: cost.value === '' ? null : Number(cost.value), faultsFixed: [...fixedCodes],
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
      const summary = [keys.length || work.jobs.size ? workSummary(v, keys) : null, work.repair ? t('repairWord') : null].filter(Boolean).join(' + ');
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
      $('last-sync').textContent = t ? `Updated ${timeAgo(t.toISOString())}` : '';
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
addEventListener('hashchange', () => { showTab(); render(); });
for (const b of document.querySelectorAll('#lang button')) {
  b.addEventListener('click', () => { setLang(b.dataset.lang); render(); });
}
$('tr-search').addEventListener('input', renderTrailers);
$('tr-filter').addEventListener('change', renderTrailers);
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
applyLogPeriod();
showTab();
$('t-close').addEventListener('click', () => $('truck').close());
$('s-close').addEventListener('click', () => $('schedule').close());
$('schedule').addEventListener('close', () => { openGroupKey = null; });
$('schedule').addEventListener('click', (e) => { if (e.target === $('schedule')) $('schedule').close(); });
$('truck').addEventListener('close', () => { openTruckId = null; });
$('w-close').addEventListener('click', () => $('work').close());
$('work').addEventListener('close', () => { work = null; });
$('log-add').addEventListener('click', () => openWork(null));
$('shop-other').addEventListener('click', () => openWork(null));
// Clicking the dimmed backdrop closes the dialog.
$('truck').addEventListener('click', (e) => { if (e.target === $('truck')) $('truck').close(); });
for (const th of document.querySelectorAll('th[data-sort]')) {
  th.addEventListener('click', () => {
    sortDir = sortKey === th.dataset.sort ? -sortDir : 1;
    sortKey = th.dataset.sort;
    render();
  });
}
