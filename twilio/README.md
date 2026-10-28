# Receipts by WhatsApp (Twilio)

The buyer sends a photo of a receipt to the company WhatsApp number. Adding
the truck to the message ("T-28") ties the receipt to that truck. The Twilio
Function in `whatsapp-receipt.js` saves each photo as a receipt "Waiting to be
read", the same as **Upload receipts** in the app, and replies "Got it". Then
it starts the "Read receipts" GitHub Action, so the receipt is read within a
few minutes (see [Read on arrival](#read-on-arrival)).

Only phone numbers listed in `ALLOWED_SENDERS` are accepted; anyone else gets
no answer.

## 1. The Function

1. Twilio Console → **Functions and Assets** → **Services** → **Create Service**, named `receipts`.
2. **Add** → **Add Function**, path `/whatsapp-receipt`. Paste the contents of
   `whatsapp-receipt.js`. Set its visibility to **Protected**, so only Twilio
   can call it.
3. **Settings → Environment Variables**:
   - `ALLOWED_SENDERS`: the buyer's name and WhatsApp number, for example
     `Maria:+19155551234` (several are separated by commas).
   - `FIREBASE_PROJECT_ID`: `aslogdev-a7225`
   - `FIREBASE_API_KEY`: the `apiKey` in `web/firebase-config.js` (public, not a secret).
   - Leave **"Add my Twilio Credentials (ACCOUNT_SID) and (AUTH_TOKEN) to ENV"**
     checked. The Function uses them to download the photos.
4. **Settings → Dependencies**: add `jimp`, version `0.22.12`. It shrinks large photos.
5. **Deploy All**, then copy the Function's URL
   (`https://receipts-1234.twil.io/whatsapp-receipt`).

## 2. Test with the WhatsApp Sandbox

1. Console → **Messaging** → **Try it out** → **Send a WhatsApp message**.
2. From the buyer's phone, send the "join …" code shown there to the sandbox number.
3. In **Sandbox settings**, set **When a message comes in** to the Function URL
   (method POST) and save.
4. Send a receipt photo with "T-28". The reply should say
   "Got it: 1 receipt for T-28". The receipt shows up in the app under
   Receipts as "Waiting to be read".

The sandbox is for testing: it's a shared Twilio number, and people must send
the join code again after a few days without messages.

## 3. The company's own WhatsApp number

1. Buy a US number in Twilio (Phone Numbers → Buy a number). It must be able
   to receive the WhatsApp verification code by SMS or voice.
2. Console → **Messaging** → **Senders** → **WhatsApp senders** → **Create new
   sender**. Twilio walks through logging in to Meta (Facebook) and creating
   or choosing the Meta Business account. The display name should match the
   business, for example "AS Logistics Receipts". Meta's approval usually
   takes hours to a few days.
3. On the new sender, set the incoming message webhook to the same Function URL.
4. Save the number as a contact on the buyer's phone.

## Text messages (MMS) instead

The same Function takes receipt photos texted to the Twilio number. In
Phone Numbers → Active numbers → the number → Messaging configuration, set
**A message comes in** to the Function URL (HTTP POST). Incoming texts work
right away; replies need the number registered for US texting (A2P 10DLC,
"Sole Proprietor" works without a business). Until then the Function saves
texted receipts without answering; once it's registered, add the environment
variable `SMS_REPLIES` = `yes`.

## Read on arrival

The Function starts the "Read receipts" Action as soon as it saves a photo.
To allow that, it needs a GitHub token that can only start Actions in this
repository:

1. GitHub → your picture → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Name `Twilio receipts`; pick an expiration (put a reminder in your calendar
   to renew it); **Repository access** → **Only select repositories** →
   `ASMT`.
3. **Permissions** → **Repository permissions** → **Actions**: **Read and
   write**. Leave everything else at "No access". **Generate token** and copy it.
4. Twilio → the `receipts` service → **Settings → Environment Variables** →
   add `GITHUB_TOKEN` with the token. Then **Deploy All**.

Send a test photo: GitHub → **Actions** → **Read receipts** should show a run
started by "workflow_dispatch" within a few seconds. Without the token (or
once it expires) nothing breaks: the hourly timer reads the receipt instead,
and the Function's logs say `start reading: GitHub 401`.

## Match as soon as work is logged

A second Function starts the same "Read receipts" Action when the mechanic
saves work in the app, so a part already bought is tied to that work in a
minute or two (otherwise it waits for the hourly run).

1. In the `receipts` service: **Add** → **Add Function**, path
   `/start-matching`. Paste the contents of `start-matching.js`.
2. Set its visibility to **Public** (the website calls it, not Twilio).
3. **Deploy All**. It uses the same `GITHUB_TOKEN` as above.

The app calls `https://receipts-4564.twil.io/start-matching` about 12 seconds
after work is saved (after its Undo), and not at all if it's undone. If your
service's domain is different, change `START_MATCHING_URL` in `web/app.js`.
Anyone could call this link, but it only starts a run that stops after a few
reads when nothing changed, and GitHub keeps at most one run waiting.

## Costs and limits

- The buyer starts every conversation, so replies are free-form and Meta
  charges nothing for them; Twilio charges a small fee per message (see
  Twilio's WhatsApp pricing).
- Send receipts as a **photo** (+ → Photos, or the camera), not as a
  document: an iPhone photo sent as a document is a .heic file, which can't
  be read, and the reply says so. If small print comes out blurry, turn on
  WhatsApp's **HD** option before sending.
