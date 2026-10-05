import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getFirestore, collection, doc, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { firebaseConfig, requireSignIn } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');

let vehicles = [];
let sortKey = 'name';
let sortDir = 1;
let unsubscribers = [];

function show(section) {
  for (const id of ['loading', 'signed-out', 'not-allowed', 'fleet']) $(id).hidden = id !== section;
}

// Trucks Samsara still lists but that are no longer reporting.
function isInactive(v) {
  return v.odometerMiles == null || /deactivated|replaced/i.test(v.name);
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
  const showInactive = $('show-inactive').checked;

  const visible = vehicles
    .filter((v) => showInactive || !isInactive(v))
    .filter((v) => !q || [v.name, v.make, v.model, v.year, v.vin].join(' ').toLowerCase().includes(q))
    .sort(compare);

  // Count by make + model.
  const counts = new Map();
  for (const v of visible) {
    const key = [v.make, v.model].filter(Boolean).join(' ') || 'Unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  $('summary').replaceChildren(
    chip(`${visible.length} trucks`, true),
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
}

function chip(text, strong = false) {
  const el = document.createElement('span');
  el.className = strong ? 'chip chip-strong' : 'chip';
  el.textContent = text;
  return el;
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

function row(v) {
  const tr = document.createElement('tr');
  if (isInactive(v)) tr.className = 'inactive';
  const miles = v.odometerMiles == null ? '—' : fmt.format(v.odometerMiles);
  const milesCell = cell(miles, 'num strong');
  if (v.odometerSource === 'gps') milesCell.title = 'GPS odometer (no ECU reading)';
  tr.append(
    cell(v.name || '—', 'strong'),
    cell(v.year || '—'),
    cell(titleCase(v.make || '—'), 'hide-sm'),
    cell(titleCase(v.model || '—'), 'wrap-sm'),
    milesCell,
    cell(v.engineHours == null ? '—' : fmt.format(v.engineHours), 'num hide-sm'),
    cell(v.vin || '—', 'mono hide-sm'),
  );
  return tr;
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
$('show-inactive').addEventListener('change', render);
for (const th of document.querySelectorAll('th[data-sort]')) {
  th.addEventListener('click', () => {
    sortDir = sortKey === th.dataset.sort ? -sortDir : 1;
    sortKey = th.dataset.sort;
    render();
  });
}
