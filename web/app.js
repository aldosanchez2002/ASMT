import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getFirestore, addDoc, collection, doc, onSnapshot, serverTimestamp, setDoc,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { firebaseConfig, requireSignIn } from './firebase-config.js';
import { matchesRule, mostUrgent, truckMaintenance } from './maintenance.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');

let vehicles = [];
let schedules = new Map(); // scheduleId -> maintenanceSchedules doc
let records = {}; // vehicleId -> serviceRecords doc
let assignments = null; // meta/schedules doc: year/model groups
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
  const rows = truckMaintenance(v, schedules, records[v.id]?.items);
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
    chip(`${overdue} overdue`, false, overdue ? 'chip-overdue' : ''),
    chip(`${soon} due soon`, false, soon ? 'chip-soon' : ''),
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => chip(`${titleCase(k)} · ${n}`)),
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
}

// ---- Schedules tab ---------------------------------------------------------

function currentTab() {
  return location.hash === '#schedules' ? 'schedules' : 'trucks';
}

function showTab() {
  const tab = currentTab();
  $('trucks-view').hidden = tab !== 'trucks';
  $('schedules-view').hidden = tab !== 'schedules';
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

function scheduleTable(schedule) {
  const wrap = el('div', 'sched-block');
  const head = el('div', 'sched-head');
  head.append(el('h3', null, schedule.name));
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
  for (const item of schedule.items) {
    const tr = el('tr');
    tr.append(el('td', 'strong', item.name), el('td', 'interval-cell', intervalText(item)));
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

function renderSchedules() {
  if (currentTab() !== 'schedules') return;
  const groupsEl = $('sched-groups');
  if (!assignments || !schedules.size) {
    $('sched-intro').textContent = 'Loading schedules…';
    groupsEl.replaceChildren();
    return;
  }
  $('sched-intro').textContent = `Manufacturer maintenance schedules for each model and year in the fleet, at the ${assignments.dutyCycle} duty cycle. ${assignments.notes}`;

  // Remember which groups were open so live updates don't collapse them.
  const open = new Set([...groupsEl.querySelectorAll('details.group[open]')].map((d) => d.dataset.key));

  const groups = assignments.assignments.map((a) => ({
    ...a,
    key: a.schedules.join('|') + JSON.stringify(a.match),
    trucks: vehicles
      .filter((v) => matchesRule(v, a.match))
      .sort((x, y) => String(x.name).localeCompare(String(y.name), undefined, { numeric: true })),
  }));
  // Groups with trucks first, then the rest.
  groups.sort((a, b) => (b.trucks.length > 0) - (a.trucks.length > 0));

  groupsEl.replaceChildren(...groups.map((g) => {
    const details = el('details', `group${g.trucks.length ? '' : ' group-empty'}`);
    details.dataset.key = g.key;
    details.open = open.has(g.key);
    const summary = el('summary');
    const titleRow = el('div', 'group-title');
    titleRow.append(
      el('span', 'strong', groupTitle(g.match, g.trucks)),
      el('span', 'chip', g.trucks.length ? plural(g.trucks.length, 'truck') : 'No trucks in fleet'),
    );
    const engine = g.schedules.map((id) => schedules.get(id)).find((s) => s?.category === 'engine');
    const covers = `Applies to ${yearRange(g.match.yearMin, g.match.yearMax)} models`;
    summary.append(titleRow, el('div', 'muted', [engine?.name, covers, g.notes].filter(Boolean).join(' · ')));
    details.append(summary);

    const body = el('div', 'group-body');
    if (g.trucks.length) {
      const chips = el('div', 'truck-chips');
      for (const v of g.trucks) {
        const b = el('button', 'chip chip-btn', `${v.name} · ${v.year}`);
        b.type = 'button';
        b.addEventListener('click', () => openTruck(v.id));
        chips.append(b);
      }
      body.append(chips);
    }
    for (const id of g.schedules) {
      const schedule = schedules.get(id);
      if (schedule) body.append(scheduleTable(schedule));
    }
    details.append(body);
    return details;
  }));
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
    head.append(el('h3', null, schedule.name));
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
    onSnapshot(doc(db, 'meta', 'schedules'), (snap) => {
      assignments = snap.data() ?? null;
      renderSchedules();
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
addEventListener('hashchange', () => { showTab(); renderSchedules(); });
showTab();
$('t-close').addEventListener('click', () => $('truck').close());
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
