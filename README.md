# ASMT: Fleet Miles

A simple web app that lists every truck in the fleet with its model and current miles. The data comes from Samsara.

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
- The **website only reads Firestore**. Firestore's security rules allow reads only for signed-in Google accounts listed in `ALLOWED_EMAILS`. Nobody can write from the browser.
- `web/firebase-config.js` holds Firebase's *public* web config. Every Firebase site ships these values to the browser, so they aren't secrets.

## One-time setup

### 1. Create the Firebase project
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. **Build → Firestore Database → Create database**. Choose production mode and a US region.
3. **Build → Authentication → Get started → Sign-in method → Google → Enable**.
4. **Authentication → Settings → Authorized domains**: add your domain, e.g. `yourdomain.com`.
5. **Project settings → General → Your apps → Web (`</>`)**: register an app, then copy the config values into `web/firebase-config.js`.
6. **Firestore → Rules**: paste in the contents of `firestore.rules` and click **Publish**.
7. **Project settings → Service accounts → Generate new private key**. This downloads a JSON file. **Don't commit it.** You'll paste it into a GitHub secret next, then delete the file.

### 2. Add GitHub secrets
In the repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `SAMSARA_API_KEY` | Your Samsara API token (read-only is enough) |
| `FIREBASE_SERVICE_ACCOUNT` | The entire contents of the service-account JSON file |
| `ALLOWED_EMAILS` | Google account(s) allowed to view the site, comma-separated |

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
| `updatedAt` | When the sync last wrote this truck |

`meta/sync`: `lastRun`, `vehicleCount` · `allowedUsers/{email}`: viewer allowlist (managed by the sync job)
