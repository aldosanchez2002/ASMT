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

### Texting registration (A2P 10DLC)

Approved Nov 2, 2026. Registered as a Sole Proprietor brand (Aldo Sanchez) with a Sole Proprietor
campaign for the program "aslog" (verbal consent from employees, no
marketing). The campaign points to https://aslog.dev/privacy/ and
https://aslog.dev/terms/ (`web/privacy`, `web/terms`); keep them in step with
what the campaign says.

Once `SMS_REPLIES` is `yes`, each sender's first answered text also gets the
registered opt-in confirmation (it names aslog and says how to stop), and a
receipt reply adds "Reply STOP to opt out." at most once every 30 days per
sender (both remembered by name in `meta/smsOptIn`, never by number). Other
replies are plain ("Got a receipt for T-24."). STOP, START and
HELP are answered by Twilio, not the Function: in the number's Messaging
Service, **Opt-Out Management** has the registered messages:

- **STOP**: "aslog: You are unsubscribed and will get no more messages from this number. Reply START to resume."
- **START**: "aslog: You're enrolled to send parts receipts to this number. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out."
- **HELP**: "aslog: Text a photo of a parts receipt to send it. For help, ask the office or email aldosanchez2002@gmail.com. Message frequency varies. Msg & data rates may apply. Reply STOP to cancel."

The Messaging Service's **Integration** is "Defer to sender's webhook", so
texts still reach this Function.

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

## What was read, texted back

Once a texted receipt is read, its sender gets a text with what was read
(`scripts/receipt-reply.mjs` builds it): "Read FleetPride $12.40: Oil filter
for T-24. Wrong truck? Reply with the truck number." The truck is named when
the receipt or a text named one (it never asks for one). After the last try on a photo that
can't be read: "That photo could not be read". The reader posts it to a
second Function, `/receipt-read` (`twilio/receipt-read.js`), which looks up
the sender's number in `ALLOWED_SENDERS` (phone numbers stay in Twilio) and
sends it once per reading.

Texting a truck after the photo ("T-24", "24", "camión 24") puts it on the
sender's latest receipt from the last 2 days and reads it again with that
truck (a receipt already matched or edited by the office keeps its matches;
the truck goes in its note). `whatsapp-receipt.js` handles that.

Setup, once:

1. Make up a long random phrase (30+ characters; nobody types it).
2. GitHub → the repository → Settings → Secrets and variables → Actions →
   New repository secret: `READ_REPLY_SECRET` = that phrase.
3. Twilio → Functions → the receipts service → Environment Variables:
   `READ_REPLY_SECRET` = the same phrase, and `MESSAGING_SERVICE_SID` = the
   Messaging Service SID (MG…, Messaging → Services).
4. Add a Function at path `/receipt-read`, paste `twilio/receipt-read.js`, set
   its visibility to **Public**, paste the latest `whatsapp-receipt.js` too,
   and **Deploy All**.

## Purchases with no receipt

Cash: a text with an amount and no photo ("cash drive axle T-24 $350", "paid
cash brake chamber $45", "pagué en efectivo flecha T-24 350") is saved as a
purchase with no receipt (`cashFrom` and `saveCash` in `whatsapp-receipt.js`)
and answered "Got a cash purchase: Drive axle $350 for T-24." A truck texted
afterwards goes straight on it. Cash App, Zelle and other payments: a payment
screenshot with a text ("starter T-31") is read like a receipt; the reader
takes who was paid and the amount from the screenshot and the item from the
text, and the reading reply names the app ("Read Juan's Truck Parts $180.00
(Cash App): Starter for T-31…").

Both wait for admin's approval (`approval: 'pending'`, Admin → Parts →
Receipts → To review → Without a receipt) and count toward the truck only
once approved (`web/items.js`).

## Registration and inspection papers

A photo whose text says registration (registro, placas, cab card, tags) or
inspection (inspección), with the unit ("54231 registration", "T-24
inspection"), is saved with `docType` and answered "Got the registration for
54231." The reader reads it as paperwork (`scripts/paperwork-reader.mjs`),
updates `compliance/{unitId}` (dates, plate, state, and a `history` entry),
adds the fee as that unit's cost, and texts back what was read.
