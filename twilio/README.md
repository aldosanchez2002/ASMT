# Receipts by WhatsApp (Twilio)

The buyer sends a photo of a receipt to the company WhatsApp number. Adding
the truck to the message ("T-28") ties the receipt to that truck. The Twilio
Function in `whatsapp-receipt.js` saves each photo as a receipt "Waiting to be
read", the same as **Upload receipts** in the app, and replies "Got it". The
"Read receipts" GitHub Action reads it from there.

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

## Costs and limits

- The buyer starts every conversation, so replies are free-form and Meta
  charges nothing for them; Twilio charges a small fee per message (see
  Twilio's WhatsApp pricing).
- Send receipts as a **photo** (+ → Photos, or the camera), not as a
  document: an iPhone photo sent as a document is a .heic file, which can't
  be read, and the reply says so. If small print comes out blurry, turn on
  WhatsApp's **HD** option before sending.
