import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getFirestore, addDoc, collection, deleteField, doc, onSnapshot, serverTimestamp, setDoc,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { firebaseConfig, requireSignIn } from './firebase-config.js';
import {
  dutyFor, effectiveSettings, matchesRule, mostUrgent, resolveItems, truckMaintenance,
} from './maintenance.js';

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
const dutyModels = () => assignments?.dutyModels ?? {};
const settings = () => effectiveSettings(assignments?.settings, savedSettings);
let serviceLog = []; // serviceLog docs (one per Mark done)
let trailers = []; // trailers docs
let trSortKey = 'name';
let trSortDir = 1;
let openTruckId = null; // truck shown in the detail dialog
let openFormKey = null; // item whose "Mark done" form is open
let sortKey = 'name';
let sortDir = 1;
let unsubscribers = [];

function show(section) {
  for (const id of ['loading', 'signed-out', 'not-allowed', 'fleet']) $(id).hidden = id !== section;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Trucks that haven't reported in a week are shown dimmed.
function isQuiet(v) {
  return !v.lastReportedAt || Date.now() - Date.parse(v.lastReportedAt) > 7 * DAY_MS;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const STATUS_RANK = { overdue: 0, soon: 1, ok: 2 };
const STATUS_LABEL = {
  overdue: 'Overdue', soon: 'Due soon', ok: 'OK', done: 'Done', 'n/a': 'N/A',
  'as-needed': 'As needed', 'no-record': 'Waiting for sync',
};

// Attaches each truck's maintenance rows and its most urgent item.
function withMaintenance(v) {
  const rows = truckMaintenance(v, schedules, records[v.id]?.items, new Date(), settings(), dutyModels(), dutyDocs[v.id]);
  const next = mostUrgent(rows);
  const rank = next ? STATUS_RANK[next.status] : 3;
  return { ...v, rows, next, nextRank: rank * 10 + Math.max(-5, Math.min(5, next?.urgency ?? 5)) };
}

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

function render() {
  const q = $('search').value.trim().toLowerCase();
  const attentionOnly = $('filter').value === 'attention';

  const all = vehicles.map(withMaintenance);
  const visible = all
    .filter((v) => !q || [v.name, v.make, v.model, v.year, v.vin].join(' ').toLowerCase().includes(q))
    .filter((v) => !attentionOnly || (v.next && v.next.status !== 'ok'))
    .sort(compare);
  const overdue = all.filter((v) => v.next?.status === 'overdue').length;
  const soon = all.filter((v) => v.next?.status === 'soon').length;

  // Count by make + model.
  const counts = new Map();
  for (const v of visible) {
    const key = [v.make, v.model].filter(Boolean).join(' ') || 'Unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  $('summary').replaceChildren(
    chip(`${visible.length} trucks`, true),
    filterChip(`${overdue} overdue`, overdue ? 'chip-overdue' : ''),
    filterChip(`${soon} due soon`, soon ? 'chip-soon' : ''),
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => chip(`${titleCase(k)} · ${n}`, false, 'hide-sm')),
  );

  $('rows').replaceChildren(...visible.map(row));
  $('empty').hidden = visible.length > 0;
  $('empty').textContent = vehicles.length
    ? 'No trucks match.'
    : 'No trucks in the database yet. On GitHub, run Actions → "Sync Samsara to Firestore".';

  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.dataset.dir = sortDir === 1 ? 'asc' : 'desc';
  }

  if (openTruckId) renderTruck(all.find((v) => v.id === openTruckId));
  renderSchedules();
  renderLog();
  renderTrailers();
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

function renderLog() {
  if (currentTab() !== 'log') return;
  renderLogUnits();
  const from = $('log-from').value;
  const to = $('log-to').value;
  const unit = $('log-unit').value;

  const rows = serviceLog
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to) && (!unit || e.vehicleId === unit))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.loggedAtMs ?? 0) - (a.loggedAtMs ?? 0));

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
    const sched = schedules.get(e.scheduleId);
    if (sched) service.append(el('div', 'item-meta', sched.name));
    if (e.note) service.append(el('div', 'item-meta show-sm', `"${e.note}"`));
    tr.append(
      el('td', null, e.date || '—'),
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

const TABS = ['trucks', 'trailers', 'schedules', 'log'];

function currentTab() {
  const tab = location.hash.slice(1);
  return TABS.includes(tab) ? tab : 'trucks';
}

function showTab() {
  const tab = currentTab();
  for (const t of TABS) $(`${t}-view`).hidden = t !== tab;
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
      if (current[d.id] !== value) save(d, value, buttons);
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
  $('sched-intro').textContent = 'Tap a model to see its engine, chassis and DOT schedules. Set your oil, fuel filter and coolant in Fleet setup above.';

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

// A chip that toggles the list between all trucks and "Overdue or due soon".
function filterChip(text, extraClass) {
  const b = el('button', ['chip', 'chip-btn', extraClass].filter(Boolean).join(' '), text);
  b.type = 'button';
  b.addEventListener('click', () => {
    $('filter').value = $('filter').value === 'attention' ? 'all' : 'attention';
    render();
  });
  return b;
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
  if (!v.next) {
    td.append(el('span', 'muted-cell', v.scheduleIds?.length ? 'Waiting for sync' : 'No schedule'));
    return td;
  }
  td.append(statusDot(v.next.status), el('span', 'next-name', v.next.item.name), el('span', `next-when when-${v.next.status}`, limitingText(v.next)));
  return td;
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
    cell(v.name || '—', 'strong wrap-sm'),
    cell(v.year || '—', 'hide-sm'),
    cell(titleCase(v.make || '—'), 'hide-sm'),
    cell(titleCase(v.model || '—'), 'hide-sm'),
    milesCell,
    nextCell(v),
    cell(v.engineHours == null ? '—' : fmt.format(v.engineHours), 'num hide-sm'),
    cell(timeAgo(v.lastReportedAt), 'muted-cell hide-sm'),
  );
  return tr;
}

// ---- Truck detail dialog -------------------------------------------------

function openTruck(id) {
  openTruckId = id;
  openFormKey = null;
  render();
  if (!$('truck').open) $('truck').showModal();
}

function dutySection(v, models) {
  const dutyDoc = dutyDocs[v.id] ?? {};
  const section = el('section', 'duty');
  section.append(el('h3', 'duty-title', 'Duty cycle'));
  const m = dutyDoc.metrics;
  section.append(el('p', 'muted duty-metrics', m
    ? `Last ${m.windowDays} days: ${fmt.format(m.annualMiles)} mi/yr · ${m.mpg ?? '—'} MPG · ${m.idlePct ?? '—'}% idle`
    : 'Not classified yet. Using the default (normal OTR) schedule until the sync has enough Samsara data.'));

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
  const what = last.source === 'baseline' ? 'Starting point' : 'Last done';
  const miles = last.miles != null ? `${fmt.format(last.miles)} mi` : '';
  return `${what}: ${[miles, last.date].filter(Boolean).join(' on ')}${last.note ? ` · "${last.note}"` : ''}`;
}

function dueText(r) {
  const parts = [];
  if (r.dueMiles != null) parts.push(`${fmt.format(r.dueMiles)} mi`);
  if (r.dueHours != null) parts.push(`${fmt.format(r.dueHours)} h`);
  if (r.dueDate) parts.push(r.dueDate);
  return parts.length ? `Due at ${parts.join(' or ')} · ${limitingText(r)}` : STATUS_LABEL[r.status];
}

function renderTruck(v) {
  if (!v) { $('truck').close(); return; }
  $('t-title').textContent = v.name;
  $('t-sub').textContent = [
    [v.year, titleCase(v.make || ''), titleCase(v.model || '')].filter(Boolean).join(' '),
    v.odometerMiles != null && `${fmt.format(v.odometerMiles)} mi`,
    v.engineHours != null && `${fmt.format(v.engineHours)} engine h`,
    v.vin && `VIN ${v.vin}`,
  ].filter(Boolean).join(' · ');

  const body = $('t-body');
  body.replaceChildren();
  const models = truckDutyModels(v);
  if (models.length) body.append(dutySection(v, models));
  if (!v.rows.length) {
    body.append(el('p', 'muted', v.scheduleIds?.length
      ? 'Schedules are loading, or the sync has not recorded a starting point yet.'
      : 'No maintenance schedule matches this truck. Add a rule in data/maintenance-schedules.json.'));
    return;
  }

  for (const scheduleId of v.scheduleIds) {
    const schedule = schedules.get(scheduleId);
    if (!schedule) continue;
    const section = el('section', 'sched');
    const head = el('div', 'sched-head');
    const duty = v.rows.find((x) => x.schedule.id === scheduleId)?.duty;
    const h3 = el('h3');
    h3.append(categoryTag(schedule), el('span', null, duty ? `${schedule.name} · ${dutyLabel(schedule.dutyModel, duty)}` : schedule.name));
    head.append(h3);
    const link = el('a', 'muted', 'Manual');
    link.href = schedule.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    head.append(link);
    section.append(head);

    for (const r of v.rows.filter((x) => x.schedule.id === scheduleId)) {
      section.append(itemRow(v, r));
    }
    body.append(section);
  }
}

function itemRow(v, r) {
  const li = el('div', `item item-${r.status}`);
  const top = el('div', 'item-top');
  const name = el('div', 'item-name');
  name.append(statusDot(r.status), el('span', null, r.item.name));
  if (r.item.adjusted) name.append(el('span', 'badge', 'Adjusted'));
  top.append(name);
  if (r.status !== 'as-needed') {
    const btn = el('button', 'btn btn-ghost btn-sm', openFormKey === r.key ? 'Cancel' : 'Mark done');
    btn.addEventListener('click', () => {
      openFormKey = openFormKey === r.key ? null : r.key;
      render();
    });
    top.append(btn);
  }
  li.append(top);
  li.append(el('div', `item-due when-${r.status}`, dueText(r)));
  li.append(el('div', 'item-meta', `${intervalText(r.item)} · ${lastText(r.last)}`));
  if (r.item.notes) li.append(el('div', 'item-meta', r.item.notes));
  if (r.item.tasks?.length) {
    const details = el('details', 'item-tasks');
    details.append(el('summary', null, `${r.item.tasks.length} tasks`));
    const ul = el('ul');
    r.item.tasks.forEach((t) => ul.append(el('li', null, t)));
    details.append(ul);
    li.append(details);
  }
  if (openFormKey === r.key) li.append(doneForm(v, r));
  return li;
}

function field(label, input) {
  const wrap = el('label', 'field');
  wrap.append(el('span', null, label), input);
  return wrap;
}

function doneForm(v, r) {
  const form = el('form', 'done-form');
  const miles = Object.assign(el('input'), { type: 'number', min: 0, required: true, value: v.odometerMiles ?? '' });
  const hours = Object.assign(el('input'), { type: 'number', min: 0, value: v.engineHours ?? '' });
  const date = Object.assign(el('input'), { type: 'date', required: true, value: new Date().toLocaleDateString('en-CA') });
  const note = Object.assign(el('input'), { type: 'text', placeholder: 'Optional (shop, invoice #, notes)' });
  const save = el('button', 'btn btn-sm', 'Save');
  save.type = 'submit';
  form.append(field('Miles', miles), field('Engine hours', hours), field('Date', date), field('Note', note), save);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    save.textContent = 'Saving…';
    const record = {
      miles: Number(miles.value),
      hours: hours.value === '' ? null : Number(hours.value),
      date: date.value,
      note: note.value.trim(),
      source: 'done',
    };
    try {
      await setDoc(doc(db, 'serviceRecords', v.id), {
        vehicleId: v.id,
        items: { [r.key]: { ...record, loggedAt: serverTimestamp() } },
      }, { merge: true });
      await addDoc(collection(db, 'serviceLog'), {
        ...record,
        vehicleId: v.id,
        vehicleName: v.name,
        scheduleId: r.schedule.id,
        itemId: r.item.id,
        itemName: r.item.name,
        loggedAt: serverTimestamp(),
      });
      openFormKey = null;
      render();
    } catch (err) {
      save.disabled = false;
      save.textContent = 'Save';
      showAppError(`Could not save: ${err.message}`);
    }
  });
  return form;
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
      renderLog();
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
      $('last-sync').textContent = t ? `Synced ${t.toLocaleString()}` : '';
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
$('filter').addEventListener('change', render);
addEventListener('hashchange', () => { showTab(); renderSchedules(); renderLog(); renderTrailers(); });
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
applyLogPeriod();
showTab();
$('t-close').addEventListener('click', () => $('truck').close());
$('s-close').addEventListener('click', () => $('schedule').close());
$('schedule').addEventListener('close', () => { openGroupKey = null; });
$('schedule').addEventListener('click', (e) => { if (e.target === $('schedule')) $('schedule').close(); });
$('truck').addEventListener('close', () => { openTruckId = null; openFormKey = null; });
// Clicking the dimmed backdrop closes the dialog.
$('truck').addEventListener('click', (e) => { if (e.target === $('truck')) $('truck').close(); });
for (const th of document.querySelectorAll('th[data-sort]')) {
  th.addEventListener('click', () => {
    sortDir = sortKey === th.dataset.sort ? -sortDir : 1;
    sortKey = th.dataset.sort;
    render();
  });
}
