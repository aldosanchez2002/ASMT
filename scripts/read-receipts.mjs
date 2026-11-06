// Reads the receipt photos the buyer uploaded ("waiting" receipts) with Claude
// and fills in each receipt: store, date, items matched to the stock list,
// tax and total. Run by the "Read receipts" GitHub Action.
//
// Needs ANTHROPIC_API_KEY (the workflow passes the AS_LOG_KEY GitHub secret
// as it). Without it, it does nothing. With READ_REPLY_SECRET, a texted
// receipt's sender gets a text saying what was read (scripts/receipt-reply.mjs).
// Usage: node scripts/read-receipts.mjs [--dry-run]   (dry run: read, don't
// save; what was read goes to dry-run-receipts.json for match-items --dry-run)

import { writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { commit, getDoc, listDocs, mergeWrite, queryDocs } from './firestore-rest.mjs';
import { memoryText } from './ai-memory.mjs';
import { RECEIPT_SCHEMA, SYSTEM_PROMPT, contextText, receiptFromReading } from './receipt-reader.mjs';
import { readReplyText, sendReadReply } from './receipt-reply.mjs';
import { PAPERWORK_PROMPT, PAPERWORK_SCHEMA, paperworkContext, paperworkFromReading, paperworkReplyText } from './paperwork-reader.mjs';

const MAX_TRIES = 3;

// One photo (a data URL) -> Claude's reading, in RECEIPT_SCHEMA's shape.
export async function readPhoto(client, photo, context, { system = SYSTEM_PROMPT, schema = RECEIPT_SCHEMA } = {}) {
  const [, mediaType, data] = photo.match(/^data:(image\/[a-z+]+);base64,(.+)$/) ?? [];
  if (!data) throw new Error('The saved photo is not an image');
  const response = await client.beta.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 16000,
    // If Claude Sonnet 5.5 declines, Anthropic's recommended model takes over.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        { type: 'text', text: context },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to read this receipt');
  if (response.stop_reason === 'max_tokens') throw new Error('The answer was cut off (receipt too long)');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('No answer came back');
  console.log(`  tokens: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out`);
  return JSON.parse(text);
}

// Every truck and trailer with the VIN and plate on file, to tell which unit a paper is for.
async function paperworkUnits(vehicles) {
  const [trailers, compliance] = await Promise.all([listDocs('trailers'), listDocs('compliance')]);
  const unit = (x, unitType) => ({ id: x.id, name: x.name, unitType, vin: x.vin ?? compliance[x.id]?.vin ?? null, plate: compliance[x.id]?.plate ?? null });
  return [...vehicles.filter((v) => v.name).map((v) => unit(v, 'truck')), ...Object.values(trailers).filter((x) => x.name).map((x) => unit(x, 'trailer'))];
}

// A registration or inspection paper: read it, then update that unit's dates
// (keeping what they were, so a re-read for another unit puts them back).
async function readPaperwork(client, r, photo, units) {
  const reading = await readPhoto(client, photo, paperworkContext(units, r.note), { system: PAPERWORK_PROMPT, schema: PAPERWORK_SCHEMA });
  const { receipt, change } = paperworkFromReading(reading, units, { note: r.note, docType: r.docType, today: r.date });
  console.log(`  paperwork: ${receipt.paperwork.kind} for ${receipt.paperwork.unitName ?? '?'} · expires ${receipt.paperwork.expires ?? '?'} · fee ${receipt.total ?? '-'}${receipt.problems.length ? ` · ${receipt.problems.join('; ')}` : ''}`);
  const writes = [];
  const was = r.paperwork?.applied ? r.paperwork : null;
  if (was && was.unitId !== change?.unitId) {
    const before = await getDoc(`compliance/${was.unitId}`);
    writes.push(mergeWrite(`compliance/${was.unitId}`, { ...was.before, history: (before?.history ?? []).filter((h) => h.receiptId !== r.id), updatedAt: new Date().toISOString() }));
  }
  if (change) {
    const current = (await getDoc(`compliance/${change.unitId}`)) ?? {};
    const beforeFields = was?.unitId === change.unitId ? was.before : Object.fromEntries(Object.keys(change.fields).map((k) => [k, current[k] ?? null]));
    const history = [...(current.history ?? []).filter((h) => h.receiptId !== r.id), { ...change.entry, receiptId: r.id }];
    writes.push(mergeWrite(`compliance/${change.unitId}`, {
      unitId: change.unitId, name: change.unitName, unitType: change.unitType, ...change.fields, history, updatedAt: new Date().toISOString(),
    }));
    receipt.paperwork = { ...receipt.paperwork, applied: true, before: beforeFields };
  }
  return { receipt, writes };
}

// Texted receipts only: the sender hears back what was read.
async function replyToSender(receipt, text) {
  if (receipt.source !== 'sms') return;
  const { sent, why } = await sendReadReply(receipt.id, text);
  console.log(`  reply ${sent ? 'sent' : `not sent (${why ?? 'no reason given'})`}: ${text}`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  // Only the waiting receipts: one read when there are none (most runs).
  const receipts = await queryDocs('receipts', [['status', '==', 'waiting']]);
  if (!receipts.length) {
    console.log('No receipts waiting to be read.');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`${receipts.length} receipt(s) waiting, but no Claude API key is set (GitHub secret AS_LOG_KEY).`);
    return;
  }

  const [parts, vehicles] = await Promise.all([listDocs('parts'), listDocs('vehicles')]).then((x) => x.map(Object.values));
  // The memory only uses the latest corrections.
  const corrections = await queryDocs('corrections', [], { orderBy: ['at', 'DESCENDING'], limit: 60 });
  const memory = memoryText('reading', await getDoc('meta/aiMemory'), corrections, parts);
  const client = new Anthropic();
  // Receipts read in the last year, to catch the same invoice uploaded twice.
  const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const others = (await queryDocs('receipts', [['date', '>=', yearAgo]])).filter((r) => r.status === 'read' || r.status === 'review');

  let done = 0;
  let units = null; // trucks and trailers, loaded once if a paper comes in
  const readNow = [];
  for (const r of receipts) {
    console.log(`Receipt ${r.id} (uploaded ${r.date ?? '?'}${r.note ? `, note "${r.note}"` : ''})`);
    try {
      const photo = (await getDoc(`receiptPhotos/${r.id}`))?.data;
      if (!photo) throw new Error('No photo saved for this receipt');
      if (r.docType) {
        const { receipt, writes } = await readPaperwork(client, r, photo, units ??= await paperworkUnits(vehicles));
        if (!dryRun) await commit([mergeWrite(`receipts/${r.id}`, { ...receipt, readAt: new Date().toISOString(), readError: null }), ...writes]);
        if (!dryRun) await replyToSender(r, paperworkReplyText(receipt));
        done += 1;
        continue;
      }
      const reading = await readPhoto(client, photo, contextText(parts, vehicles, r.note, memory));
      // A registration or inspection sent without saying so: read it again as that paper.
      if (reading.document === 'registration' || reading.document === 'inspection') {
        console.log(`  this is a ${reading.document}, not a receipt`);
        const paper = { ...r, docType: reading.document };
        const { receipt, writes } = await readPaperwork(client, paper, photo, units ??= await paperworkUnits(vehicles));
        if (!dryRun) await commit([mergeWrite(`receipts/${r.id}`, { ...receipt, docType: reading.document, readAt: new Date().toISOString(), readError: null }), ...writes]);
        if (!dryRun) await replyToSender(paper, paperworkReplyText(receipt));
        done += 1;
        continue;
      }
      const result = receiptFromReading(reading, parts, vehicles, { uploadedDate: r.date, trucks: r.trucks ?? [], others, note: r.note });
      // The decision, in order: legible, registration, inspection, receipt (shop or service).
      const shop = result.lines.filter((l) => l.to === 'shop').length;
      const stock = result.lines.filter((l) => l.to === 'stock').length;
      console.log(`  0 legible: ${reading.readable ? 'yes' : 'no'} · 1 registration: no · 2 inspection: no · 3 receipt: ${result.lines.length} item(s) → shop ${shop}, stock ${stock}, service ${result.lines.length - shop - stock}`);
      const feeText = result.fees.length ? ` · fees ${result.fees.map((f) => `${f.label} ${f.amount}`).join(', ')}` : '';
      console.log(`  ${result.status}: ${result.vendor || 'no store'} ${result.invoiceNumber ?? ''} ${result.date} · ${result.lines.length} item(s) · tax ${result.tax ?? '-'}${feeText} · total ${result.total ?? '?'}${result.problems.length ? ` · ${result.problems.join('; ')}` : ''}`);
      const truckName = (id) => vehicles.find((v) => v.id === id)?.name ?? id;
      for (const l of result.lines) {
        const where = l.part ? `${l.part}${l.for ? ` for ${l.for[0].name}` : ''}` : l.to === 'truck' ? truckName(l.vehicleId) : l.to === 'shop' ? 'shop' : l.suggestedPart ? `maybe ${l.suggestedPart}` : 'pool';
        const choices = l.truckChoices ? ` (${l.truckChoices.map(truckName).join(' or ')})` : '';
        console.log(`    ${l.text}${l.partNumber ? ` [${l.partNumber}]` : ''} x${l.qty} ${l.price ?? '?'} (real ${l.cost ?? '?'}) ${l.kind} -> ${where}${choices}${l.truckFrom ? ` via ${l.truckFrom}` : ''}${l.flags.length ? ` [${l.flags.join(', ')}]` : ''}`);
      }
      if (!dryRun) await commit([mergeWrite(`receipts/${r.id}`, { ...result, readAt: new Date().toISOString(), readError: null })]);
      if (!dryRun) await replyToSender(r, readReplyText(result, vehicles));
      others.push({ ...result, id: r.id }); // two photos of one receipt in the same batch
      readNow.push({ ...r, ...result });
      done += 1;
    } catch (err) {
      // Typed SDK errors carry a status; anything else (bad photo, bad JSON) doesn't.
      const message = err instanceof Anthropic.APIError ? `Claude API error ${err.status}: ${err.message}` : err.message;
      const tries = (r.readTries ?? 0) + 1;
      console.warn(`  could not read (try ${tries}/${MAX_TRIES}): ${message}`);
      if (!dryRun) {
        await commit([mergeWrite(`receipts/${r.id}`, {
          readTries: tries, readError: message, ...(tries >= MAX_TRIES ? { status: 'error' } : {}),
        })]);
        if (tries >= MAX_TRIES) await replyToSender(r, readReplyText({ status: 'error' }));
      }
    }
  }
  console.log(`Read ${done} of ${receipts.length} receipt(s)${dryRun ? ' (dry run, nothing saved)' : ''}.`);
  if (dryRun) writeFileSync('dry-run-receipts.json', JSON.stringify(readNow));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
