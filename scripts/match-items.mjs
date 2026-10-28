// Ties what was bought to the work it went into. Run by the "Read receipts"
// GitHub Action right after the receipts are read, in two passes:
//   1. Rules (no AI): what the work log says it used (oil, filters, tires,
//      batteries) comes out of the oldest batch of that part (ruleUses in
//      web/items.js).
//   2. Claude: repair parts, labor and cores are matched to the repairs they
//      were used in. Sure ones count right away, the rest wait for admin.
// Each tie is an itemUses doc. It first asks Firestore whether anything new
// happened since its last check (a few reads) and stops if not; otherwise it
// loads only recent receipts, matches and repairs, and skips the Claude call
// when the open items and repairs are the same as last time.
//
// Needs ANTHROPIC_API_KEY (the AS_LOG_KEY GitHub secret). Without it, does nothing.
// Usage: node scripts/match-items.mjs [--dry-run]   (dry run: match, don't
// save; uses what read-receipts --dry-run just read, if it's there)

import { existsSync, readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { commit, getDoc, listDocs, mergeWrite, queryDocs, setWrite } from './firestore-rest.mjs';
import { memoryText } from './ai-memory.mjs';
import { MATCH_PROMPT, MATCH_SCHEMA, candidateRepairs, matchContext, matchSignature, usesFromAnswer } from './item-matcher.mjs';
import { openItems, receiptItems, repairEntries, ruleUses } from '../web/items.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);

// What can change what's open or what it could match, by when it changed:
// work logged or edited, a receipt read or edited, a match made or changed.
const CHANGES = [
  ['serviceLog', 'loggedAt', 'time'], ['serviceLog', 'updatedAt', 'time'],
  ['receipts', 'readAt', 'text'], ['receipts', 'updatedAt', 'time'],
  ['itemUses', 'createdAt', 'time'], ['itemUses', 'checkedAt', 'time'],
];

// The first kind of change since `iso` (one read per check), or null.
export async function changedSince(iso, query = queryDocs) {
  for (const [collection, field, type] of CHANGES) {
    const after = type === 'time' ? new Date(iso) : iso;
    if ((await query(collection, [[field, '>', after]], { limit: 1 })).length) return `${collection}.${field}`;
  }
  return null;
}

const newId = () => Array.from({ length: 20 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
const entries = (docs) => Object.entries(docs).map(([id, d]) => ({ ...d, id }));

export async function askClaude(client, text) {
  const response = await client.beta.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: MATCH_PROMPT,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: MATCH_SCHEMA } },
    messages: [{ role: 'user', content: text }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to match');
  if (response.stop_reason === 'max_tokens') throw new Error('The answer was cut off');
  const out = response.content.find((b) => b.type === 'text')?.text;
  if (!out) throw new Error('No answer came back');
  console.log(`  tokens: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out`);
  return JSON.parse(out);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const startedAt = new Date().toISOString();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const last = await getDoc('meta/matcher');
  if (!dryRun && last?.checkedAt) {
    const why = await changedSince(last.checkedAt);
    if (!why) {
      console.log(`Nothing new since the last check (${last.checkedAt}).`);
      return;
    }
    console.log(`New since the last check: ${why}.`);
  }

  // Only recent data: pool items are matched for 60 days after purchase, to
  // repairs up to 90 days back. Matches are always made after their receipt.
  const iso = (d) => d.toISOString().slice(0, 10);
  const [saved, uses, log, vehicles, trailers, parts, corrections] = await Promise.all([
    queryDocs('receipts', [['date', '>=', iso(daysAgo(150))]]),
    queryDocs('itemUses', [['createdAt', '>=', daysAgo(150)]]),
    queryDocs('serviceLog', [['date', '>=', iso(daysAgo(120))]]),
    listDocs('vehicles').then(entries), listDocs('trailers').then(entries), listDocs('parts').then(entries),
    queryDocs('corrections', [], { orderBy: ['at', 'DESCENDING'], limit: 60 }),
  ]);
  // A dry run sees the receipts the dry-run reader just read as if saved.
  const justRead = dryRun && existsSync('dry-run-receipts.json') ? JSON.parse(readFileSync('dry-run-receipts.json', 'utf8')) : [];
  const receipts = [...saved.filter((r) => !justRead.some((x) => x.id === r.id)), ...justRead];

  // Pass 1: the rules. What the work log used comes out of the oldest batch.
  const rule = ruleUses({ receipts, uses, log });
  for (const u of rule) console.log(`  RULE ${u.vehicleName ?? u.vehicleId}: ${u.qty} x ${u.part} from receipt ${u.receiptId}`);
  console.log(`${rule.length} use(s) of stock by rule.`);
  const ruleWrites = rule.map((u) => {
    const id = newId();
    return setWrite(`itemUses/${id}`, { ...u, id }, 'createdAt');
  });
  uses.push(...rule);
  // Remember this check (with the rule uses), so the next run only looks for what's newer.
  const markChecked = (fields = {}) => (dryRun ? null : commit([...ruleWrites, mergeWrite('meta/matcher', { checkedAt: startedAt, ...fields })]));

  // Pass 2: Claude, for repair parts, labor and cores.
  const allItems = receiptItems(receipts);
  const open = openItems(allItems, uses, { today });
  const repairs = candidateRepairs(open, repairEntries(log, { today, days: 90 }));
  console.log(`${open.length} item(s) not tied to work, ${repairs.length} repair(s) they could be from.`);
  if (!open.length || !repairs.length) {
    await markChecked();
    return;
  }

  if (!dryRun && last?.signature === matchSignature(open, repairs)) {
    console.log('Same open items and repairs as the last run.');
    await markChecked();
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No Claude API key is set (GitHub secret AS_LOG_KEY).');
    if (ruleWrites.length && !dryRun) await commit(ruleWrites);
    return;
  }

  const names = new Map([...vehicles, ...trailers].map((v) => [v.id, v.name]));
  const memory = memoryText('match', await getDoc('meta/aiMemory'), corrections, parts);
  const { text, refs } = matchContext(open, repairs, { names, uses, allItems, memory });
  const answer = await askClaude(new Anthropic(), text);
  const found = usesFromAnswer(answer, refs, { uses, names });
  for (const u of found) {
    console.log(`  ${u.status === 'auto' ? 'MATCH' : 'maybe'} ${u.confidence}%: "${u.itemText}" x${u.qty} -> ${u.vehicleName} "${repairText(refs, u.logId)}" (${u.daysApart} days) · ${u.reason}`);
  }
  console.log(`${found.filter((u) => u.status === 'auto').length} sure, ${found.filter((u) => u.status === 'doubt').length} for admin to check${dryRun ? ' (dry run, nothing saved)' : ''}.`);
  if (dryRun) return;
  const writes = [...ruleWrites, ...found.map(({ itemText, daysApart, ...u }) => {
    const id = newId();
    return setWrite(`itemUses/${id}`, { ...u, id, itemText }, 'createdAt');
  })];
  // What's left open after these matches: the next run skips Claude unless
  // something new comes in (a receipt, a repair, admin freeing an item).
  const after = openItems(allItems, [...uses, ...found], { today });
  const afterSignature = matchSignature(after, candidateRepairs(after, repairEntries(log, { today, days: 90 })));
  writes.push(mergeWrite('meta/matcher', { signature: afterSignature, lastRun: new Date().toISOString(), checkedAt: startedAt }));
  await commit(writes);
}

const repairText = (refs, logId) => {
  const e = [...refs.repairs.values()].find((x) => x.id === logId);
  return [e?.itemName, e?.note].filter(Boolean).join(' · ');
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
