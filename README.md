# aslog.dev

A simple web app that lists every truck in the fleet with its model and current miles. The data comes from Samsara.

## Shop view (main page)

`aslog.dev` opens on the **shop view**, made for mechanics: only the trucks that need work (out of service first, then overdue, then due soon), each a big card listing what's due. Tapping a card opens **Record work** with a **Due on this truck** section at the top (unticked; tap each one that was done), the shop jobs (PM, oil change, …) and repairs. Miles and date are filled in from Samsara and shown as text with a **Change** link; engine hours are hidden here. The save button says what it records ("Save: 4 items on T-23"). **EN | ES** at the top switches the shop view and the form between English and Spanish (remembered per device, `web/i18n.js`); log entries are always saved in English. **Admin** (top right) opens the full app: Trucks, Trailers, Schedules and Service log (`#trucks`, `#trailers`, `#schedules`, `#log`).

### Signals from Samsara

Each sync also saves, on every truck: `faults` (dash lamps: STOP, check engine, emissions, protect, and the active J1939 codes) and `location` (lat/lon, speed, address). `web/signals.js` turns them into what the screens show:

- **STOP lamp** trucks are always listed in the shop view, at the top, even with nothing due. Check-engine and emissions lamps show as badges, and the codes that matter (engine, aftertreatment, brakes, air system; not body/cab computer chatter) show on the card, in the truck popup and at the top of Record work, where a repair can record which codes it fixed (`faultsFixed`). Fault readings older than 7 days are only shown in the popup.
- **In yard**: parked (under 3 mph) within 250 m of the Windermere Ave yard (`SHOP` in `web/signals.js`). Those trucks come right after STOP-lamp trucks in the shop view.
- **No signal**: Samsara hasn't heard from the truck in 3+ days. Admin → Trucks has a **No signal 3+ days** button.

## How it works (and why your Samsara key stays safe)

```
 GitHub Actions (every 30 min)            Firestore               Your site (GitHub Pages)
 ┌───────────────────────────┐   write   ┌──────────┐   read    ┌──────────────────────────┐
 │ scripts/sync-samsara.mjs  │ ────────► │ vehicles │ ◄──────── │ web/  (sign in w/ Google)│
 │ uses SAMSARA_API_KEY      │  (admin)  │ meta     │  (rules)  │ no secrets in this code  │
 └───────────────────────────┘           └──────────┘           └──────────────────────────┘
          ▲ secrets live only in GitHub → Settings → Secrets
```

- The **Samsara key is stored only as a GitHub Secret**. GitHub encrypts it, it never appears in the code or the website, and it doesn't show in Action logs.
- The **website only reads Firestore**. It never writes to it.
- **Prototype mode (current):** anyone with the link can view the list, with no sign-in. To lock it down later, set `requireSignIn = true` in `web/firebase-config.js`, set the `ALLOWED_EMAILS` secret, and restrict reads in the Firestore rules.
- `web/firebase-config.js` holds Firebase's *public* web config. Every Firebase site ships these values to the browser, so they aren't secrets.

## One-time setup

### 1. Create the Firebase project
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. **Build → Firestore Database → Create database**. Choose production mode and a US region.
3. *(Only if you turn on sign-in)* **Build → Authentication → Get started → Sign-in method → Google → Enable**, then add your domain under **Authentication → Settings → Authorized domains**.
4. **Project settings → General → Your apps → Web (`</>`)**: register an app, then copy the config values into `web/firebase-config.js`.
5. **Firestore → Rules**: allow reads of `vehicles` and `meta` (the prototype currently allows anyone to read and write). Rules are managed in the Firebase console, not in this repo.
6. **Project settings → Service accounts → Generate new private key**. This downloads a JSON file. **Don't commit it.** You'll paste it into a GitHub secret next, then delete the file.

### 2. Add GitHub secrets
In the repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `SAMSARA_API_KEY` | Your Samsara API token (read-only is enough) |
| `FIREBASE_SERVICE_ACCOUNT` | *(Optional)* The entire contents of the service-account JSON file. Without it, the sync writes through Firestore's public API, which only works while your Firestore rules allow public writes. Add it before locking writes down. |
| `ALLOWED_EMAILS` | *(Only if sign-in is on)* Google account(s) allowed to view the site, comma-separated |

### 3. Run the first sync
**Actions → Sync Samsara to Firestore → Run workflow.** After that it runs every 30 minutes on its own. You should then see a `vehicles` collection in Firestore.

### 4. Publish the site on your domain
1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Merge to `main`. The **Deploy site to GitHub Pages** workflow publishes `web/`.
3. **Settings → Pages → Custom domain**: enter your domain and save, then tick **Enforce HTTPS** once it's available.
4. At your domain registrar, add these DNS records:
   - Apex domain (`yourdomain.com`): four `A` records → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `www`: a `CNAME` → `<your-github-username>.github.io`

> GitHub Pages on a free account needs a **public** repo. That's fine here, because no secrets or fleet data are in the code. A private repo with Pages needs GitHub Pro.

## Local development

```bash
npm install
SAMSARA_API_KEY=... npm run sync:dry   # prints the fleet table and writes nothing
npm run serve                          # serves web/ locally
```

## Data model

`vehicles/{samsaraVehicleId}`

| Field | Notes |
|---|---|
| `name`, `make`, `model`, `year`, `vin` | From Samsara `/fleet/vehicles` |
| `odometerMiles` | ECU odometer when available, otherwise GPS odometer |
| `odometerSource` | `obd` or `gps` |
| `odometerTime` | When Samsara last got the reading |
| `engineHours` | From the ECU |
| `lastReportedAt` | Last GPS ping from the truck. Trucks silent for 100+ days are skipped and removed from Firestore |
| `scheduleIds` | Maintenance schedules that apply to this truck (engine + chassis + DOT), from the assignment rules |
| `updatedAt` | When the sync last wrote this truck |

`meta/sync`: `lastRun`, `vehicleCount` · `allowedUsers/{email}`: viewer allowlist, used only when sign-in is on (managed by the sync job)

`maintenanceSchedules/{scheduleId}`: one document per manufacturer schedule, with `name`, `category` (`engine` / `chassis` / `regulatory`), `sourceTitle`, `sourceUrl`, and `items[]`. Each item has `id`, `name`, and any of `intervalMiles`, `intervalHours`, `intervalMonths` (whichever comes first), plus optional `firstDueMiles` (one-time or first occurrence), `rangeMiles`, `tasks[]`, and `notes`.

## Maintenance schedules

All schedules live in [`data/maintenance-schedules.json`](data/maintenance-schedules.json), set to the fleet's OTR / normal duty cycle, with the manual each interval came from. The `assignments` section maps trucks to schedules by make, model (contains match) and year range.

The site's **Schedules** tab (`aslog.dev/#schedules`) shows every model/year group, the trucks in it, and the full engine, chassis and DOT schedules with links to the manuals. The groups come from `meta/schedules`, which the sync and `npm run seed:schedules` write from the `assignments` section.

**Fleet setup toggles** (top of the Schedules tab) adjust the schedules for the whole fleet: Detroit-approved oil, frame-mounted fuel filter, extended-life coolant and Valvoline Premium Blue. They're defined in the JSON's `settings` section and saved in `meta/settings`. Schedule items react to them with `onlyWhen` (item only applies when a setting matches) and `variants` (the first variant whose `when` matches overrides the item's fields). Adjusted items are badged in the app.

To change a schedule, edit the JSON and either wait for the next sync or run `npm run seed:schedules`. Both validate the file first and fail with a list of problems if something is off (unknown schedule id, missing interval, and so on). The sync log warns about any active truck that no assignment rule matches.

## Maintenance record PDFs (DOT)

Built for roadside and compliance inspections under 49 CFR Part 396:

- **Truck popup → Download maintenance record (PDF)**: one truck's record with vehicle identification (unit number, year, make, model, VIN, plate, odometer; 396.3(b)(1)), every scheduled service with its interval, last done and next due (the "nature and due date", 396.3(b)(2)), the dated record of work performed from the service log (396.3(b)(3)), and the annual inspection status (396.17).
- **Log tab → Download PDF**: the filtered log as a table; with one truck selected it produces that truck's full record for the chosen period.
- Company name and USDOT number (Fleet setup) print at the top. Items that have only a tracking start point are shown as "Not on record", never as done.
- Each page notes the retention rules: maintenance records 1 year + 6 months after the vehicle leaves your control (396.3), annual inspection reports 14 months (396.21), DVIRs 3 months (396.11).
- PDFs are made in the browser with jsPDF (loaded from cdnjs on first use); see `web/records.js`.

## Trailers

The sync also pulls every Samsara trailer into `trailers/{samsaraId}` (name, tracker model and serial, latitude/longitude, address, speed, `lastReportedAt`), skipping units silent for 100+ days. The **Trailers** tab (`aslog.dev/#trailers`) lists them with moving / parked / quiet 7+ days counts, search, sorting and a map link per unit.

## Duty cycles (automatic)

Every sync classifies each truck's duty cycle from its last 90 days in Samsara (fuel & energy report: annual miles, MPG including idle, idle %) using each manufacturer's rules (`scripts/duty.mjs`):

| Model | Rules |
|---|---|
| Detroit | Severe: under 30k mi/yr or under 5.0 MPG · Short Haul: under 60k mi/yr or under 6.0 MPG · Efficient Long Haul: 7.0+ MPG with under 20% idle · else Long Haul |
| Cummins X15 2020+ | Severe under 5 MPG · Short Haul 5-5.9 · Normal 6-6.9 · Light 7+; idle over 40% drops Light/Normal/Short Haul one level |
| Cummins X15 EPA 2017 | Severe under 5.5 MPG · Normal 5.5-6.5 · Light over 6.5 |
| Freightliner chassis | Schedule I under 60k mi/yr · else Schedule II |

- Trucks with under 500 lifetime engine hours, or no Samsara report, keep the default (normal OTR: Long Haul / Normal / Schedule II).
- The first classification applies right away; after that a truck only switches once the new duty cycle has held for 14 days in a row.
- Results are stored in `dutyCycles/{vehicleId}` (`current`, `state` with any pending change, `metrics`). Changes are written to the service log with an **Auto** badge.
- In the truck popup, each duty model can be overridden ("Always Severe"); overrides live in `dutyCycles/{vehicleId}.override` and the sync never touches them.
- Schedule items hold the default duty cycle's intervals plus `byDuty` overrides for the others. The Schedules popup has a switcher to view any duty cycle.

## Service tracking

Tracking starts from the first sync after schedules are assigned: for every service item a truck doesn't have a record for yet, the sync writes a **baseline** ("treat as done today at the current miles and engine hours"). It never overwrites existing records.

**The service log is the source of truth.** Each visit in `serviceLog` lists the items it counts as done (`services`: record keys). An item's "last done" is the latest visit that covered it (highest miles, then latest date), worked out in the browser by `lastDoneFrom()` in `web/maintenance.js`; with no visit, it's the item's tracking start in `serviceRecords`. Editing or deleting a visit therefore updates every due date that depends on it. (`scripts/migrate-visits.mjs` moved older entries to this model and checks that every due date is unchanged.)

**Record work** (truck popup, or **+ Record work** on the Log tab) is the one form for a visit: tick the shop jobs (**PM** = oil, fuel filters, grease, levels; **Oil change**; **Air filter**; **Air dryer**; defined in `web/services.js`), add any other single service, and/or describe a **repair** with an optional cost. The "This marks done" list shows exactly which of the truck's items the save covers; untick anything that wasn't done. One save writes the service line and the repair line together (`source: 'app'`, `loggedBy`, remembered on the device), with a 10-second Undo. **Record work** on an item on an item opens the same form with that item ticked. On a local truck, a visit with higher miles also updates its miles.

**Samsara miles in Record work.** Each sync also saves every truck's reading for the day in `odometerDaily/{vehicleId}.days` (`{ "YYYY-MM-DD": { miles, hours, at } }`, UTC dates). Record work fills in miles and engine hours from Samsara: today's live reading, or that day's reading when the date is changed. If someone types miles more than 1,000 mi outside Samsara's readings from the day before to the day after, it asks before saving. Each visit records `milesSource` (`samsara` or `typed`). Local trucks have no readings. `scripts/backfill-odometer.mjs` filled in the past 12 months once (one Samsara call per day: `/fleet/vehicles/stats?time=…`):

```bash
SAMSARA_API_KEY=... node scripts/backfill-odometer.mjs --days 365          # dry run
SAMSARA_API_KEY=... node scripts/backfill-odometer.mjs --days 365 --apply
```

On the site, the **Next service** column shows each truck's most urgent item. Click a truck to see every item with its due point (miles, engine hours or date, whichever comes first) and status: overdue, due soon (within 10% of the interval, at least 2,500 mi, or 30 days) or OK. **Record work** on an item logs a service; miles, hours and date default to the truck's current values and can be edited to back-date a service.

| Collection | Contents |
|---|---|
| `serviceRecords/{vehicleId}` | `items` map keyed `{scheduleId}__{itemId}` → the item's tracking start `{ miles, hours, date, source: 'baseline' }` |
| `serviceLog/{autoId}` | One entry per visit line: truck, date, miles, hours, `services` (record keys), `itemName`, note, `loggedBy`, `type: 'repair'` + `cost` for repairs, `loggedAt` |

The **Service log** tab (`aslog.dev/#log`) lists every logged service, newest first, filtered by period (last 7/30/90 days, 12 months, all time or a custom date range, on the service date) and by unit. Clicking a unit opens that truck.

The due-date logic lives in `web/maintenance.js` and is covered by `npm test`.

## Paper work log import

`scripts/seed-work-log.mjs` loads a typed-up paper work log (JSON; format at the top of `scripts/work-log.mjs`). **Keep the file out of this repo**: it's fleet data, and `.gitignore` blocks `work-log*.json` and backups.

```bash
node scripts/seed-work-log.mjs path/to/work-log.json           # dry run: every change, before → after, nothing written
node scripts/seed-work-log.mjs path/to/work-log.json --apply   # saves a backup next to the file, then writes
node scripts/seed-work-log.mjs --undo path/to/work-log.backup-….json
```

- Every line becomes a `serviceLog` entry (`source: 'worklog'`, fixed ids `worklog-NNN-<unit>`, so re-runs don't duplicate). Repairs get `type: 'repair'` and show with a **Repair** label in the Log tab and PDFs. Lines with no date show "Not written".
- Each entry's `services` say what it counts as done: `oil`, `fuelFilters`, `chassisPm` (M1 / A / 15k), `airFilter`, `airDryer`, matched to the items the truck's schedules have. The latest one (highest miles) becomes the item's record, replacing the launch-day tracking start. A newer **Record work** on an item from the app is kept.
- `localTrucks` are added to `vehicles` as `local-<name>` with `local: true`: trucks that aren't in Samsara. Their miles come from their latest logged service and the sync never touches them.
- `outOfService` writes `vehicleStatus/{vehicleId}` (see below).

## Out of service

**Truck popup → Mark out of service** saves `vehicleStatus/{vehicleId}` (`outOfService`, `reason`, `since`). The truck shows **Out of service**, isn't counted as overdue or due soon, and the sync keeps it listed even after Samsara has been silent for 100+ days. **Back in service** in the popup undoes it.

