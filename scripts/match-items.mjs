// Ties bought items (repair parts, labor, cores from read receipts) to the
// repairs they were used in, with Claude. Run by the "Read receipts" GitHub
// Action right after the receipts are read. Each suggestion becomes an
// itemUses doc: sure ones count right away, the rest wait for admin (AI
// matches tab). Skips the Claude call when nothing changed since last run.
//
// Needs ANTHROPIC_API_KEY (the AS_LOG_KEY GitHub secret). Without it, does nothing.
// Usage: node scripts/match-items.mjs [--dry-run]   (dry run: match, don't
// save; uses what read-receipts --dry-run just read, if it's there)

import { existsSync, readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { commit, getDoc, listDocs, mergeWrite, setWrite } from './firestore-rest.mjs';
import { memoryText } from './ai-memory.mjs';
import { MATCH_PROMPT, MATCH_SCHEMA, candidateRepairs, matchContext, matchSignature, usesFromAnswer } from './item-matcher.mjs';
import { openItems, receiptItems, repairEntries } from '../web/items.js';

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
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const [saved, uses, log, vehicles, trailers, corrections, parts] = await Promise.all(
    ['receipts', 'itemUses', 'serviceLog', 'vehicles', 'trailers', 'corrections', 'parts'].map((c) => listDocs(c).then(entries)),
  );
  // A dry run sees the receipts the dry-run reader just read as if saved.
  const justRead = dryRun && existsSync('dry-run-receipts.json') ? JSON.parse(readFileSync('dry-run-receipts.json', 'utf8')) : [];
  const receipts = [...saved.filter((r) => !justRead.some((x) => x.id === r.id)), ...justRead];
  const allItems = receiptItems(receipts);
  const open = openItems(allItems, uses, { today });
  const repairs = candidateRepairs(open, repairEntries(log, { today, days: 90 }));
  console.log(`${open.length} item(s) not tied to work, ${repairs.length} repair(s) they could be from.`);
  if (!open.length || !repairs.length) return;

  const last = await getDoc('meta/matcher');
  if (!dryRun && last?.signature === matchSignature(open, repairs)) {
    console.log('Nothing changed since the last run.');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No Claude API key is set (GitHub secret AS_LOG_KEY).');
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
  const writes = found.map(({ itemText, daysApart, ...u }) => {
    const id = newId();
    return setWrite(`itemUses/${id}`, { ...u, id, itemText }, 'createdAt');
  });
  // What's left open after these matches: the next run skips Claude unless
  // something new comes in (a receipt, a repair, admin freeing an item).
  const after = openItems(allItems, [...uses, ...found], { today });
  const afterSignature = matchSignature(after, candidateRepairs(after, repairEntries(log, { today, days: 90 })));
  writes.push(mergeWrite('meta/matcher', { signature: afterSignature, lastRun: new Date().toISOString() }));
  await commit(writes);
}

const repairText = (refs, logId) => {
  const e = [...refs.repairs.values()].find((x) => x.id === logId);
  return [e?.itemName, e?.note].filter(Boolean).join(' · ');
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
