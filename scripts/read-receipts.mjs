// Reads the receipt photos the buyer uploaded ("waiting" receipts) with Claude
// and fills in each receipt: store, date, items matched to the stock list,
// tax and total. Run by the "Read receipts" GitHub Action.
//
// Needs ANTHROPIC_API_KEY (the workflow passes the AS_LOG_KEY GitHub secret
// as it). Without it, it does nothing.
// Usage: node scripts/read-receipts.mjs [--dry-run]   (dry run: read, don't
// save; what was read goes to dry-run-receipts.json for match-items --dry-run)

import { writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { commit, getDoc, listDocs, mergeWrite } from './firestore-rest.mjs';
import { memoryText } from './ai-memory.mjs';
import { RECEIPT_SCHEMA, SYSTEM_PROMPT, contextText, receiptFromReading } from './receipt-reader.mjs';

const MAX_TRIES = 3;

// One photo (a data URL) -> Claude's reading, in RECEIPT_SCHEMA's shape.
export async function readPhoto(client, photo, context) {
  const [, mediaType, data] = photo.match(/^data:(image\/[a-z+]+);base64,(.+)$/) ?? [];
  if (!data) throw new Error('The saved photo is not an image');
  const response = await client.beta.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 16000,
    // If Claude Sonnet 5.5 declines, Anthropic's recommended model takes over.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
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

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const all = Object.entries(await listDocs('receipts')).map(([id, r]) => ({ ...r, id }));
  const receipts = all.filter((r) => r.status === 'waiting');
  if (!receipts.length) {
    console.log('No receipts waiting to be read.');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`${receipts.length} receipt(s) waiting, but no Claude API key is set (GitHub secret AS_LOG_KEY).`);
    return;
  }

  const [parts, vehicles, corrections] = await Promise.all([listDocs('parts'), listDocs('vehicles'), listDocs('corrections')]).then((x) => x.map(Object.values));
  const memory = memoryText('reading', await getDoc('meta/aiMemory'), corrections, parts);
  const client = new Anthropic();
  // Receipts already read, to catch the same invoice uploaded twice.
  const others = all.filter((r) => r.status === 'read' || r.status === 'review');

  let done = 0;
  const readNow = [];
  for (const r of receipts) {
    console.log(`Receipt ${r.id} (uploaded ${r.date ?? '?'}${r.note ? `, note "${r.note}"` : ''})`);
    try {
      const photo = (await getDoc(`receiptPhotos/${r.id}`))?.data;
      if (!photo) throw new Error('No photo saved for this receipt');
      const reading = await readPhoto(client, photo, contextText(parts, vehicles, r.note, memory));
      const result = receiptFromReading(reading, parts, vehicles, { uploadedDate: r.date, trucks: r.trucks ?? [], others });
      const feeText = result.fees.length ? ` · fees ${result.fees.map((f) => `${f.label} ${f.amount}`).join(', ')}` : '';
      console.log(`  ${result.status}: ${result.vendor || 'no store'} ${result.invoiceNumber ?? ''} ${result.date} · ${result.lines.length} item(s) · tax ${result.tax ?? '-'}${feeText} · total ${result.total ?? '?'}${result.problems.length ? ` · ${result.problems.join('; ')}` : ''}`);
      const truckName = (id) => vehicles.find((v) => v.id === id)?.name ?? id;
      for (const l of result.lines) {
        const where = l.part ? `${l.part}${l.for ? ` for ${l.for[0].name}` : ''}` : l.to === 'truck' ? truckName(l.vehicleId) : l.to === 'shop' ? 'shop' : l.suggestedPart ? `maybe ${l.suggestedPart}` : 'pool';
        const choices = l.truckChoices ? ` (${l.truckChoices.map(truckName).join(' or ')})` : '';
        console.log(`    ${l.text}${l.partNumber ? ` [${l.partNumber}]` : ''} x${l.qty} ${l.price ?? '?'} (real ${l.cost ?? '?'}) ${l.kind} -> ${where}${choices}${l.truckFrom ? ` via ${l.truckFrom}` : ''}${l.flags.length ? ` [${l.flags.join(', ')}]` : ''}`);
      }
      if (!dryRun) await commit([mergeWrite(`receipts/${r.id}`, { ...result, readAt: new Date().toISOString(), readError: null })]);
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
      }
    }
  }
  console.log(`Read ${done} of ${receipts.length} receipt(s)${dryRun ? ' (dry run, nothing saved)' : ''}.`);
  if (dryRun) writeFileSync('dry-run-receipts.json', JSON.stringify(readNow));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
