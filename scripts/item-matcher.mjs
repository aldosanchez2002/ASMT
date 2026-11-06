// Matching bought items to the work they were used in: what Claude is
// asked, the shape it answers in, and how its answer becomes itemUses docs
// (web/items.js). Claude suggests; this file checks every suggestion (the
// item is free, the repair is in its time window and on an allowed truck,
// admin hasn't already said no) and decides which are sure enough to count
// on their own. No network here, so it's tested.

import { AUTO_CONFIDENCE, NEW_DAYS, daysBetween, inWindow, itemKey, repairText, usesFor } from '../web/items.js';

export const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matches'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'repair', 'qty', 'confidence', 'reason'],
        properties: {
          item: { type: 'string', description: 'item ref, like I3' },
          repair: { type: 'string', description: 'repair ref, like R5' },
          qty: { type: 'number', description: 'how many of the item went into this repair' },
          confidence: { type: 'integer', description: '0-100: how sure you are this item was used in this repair' },
          reason: { type: 'string', description: 'one short sentence, in plain English' },
        },
      },
    },
  },
};

export const MATCH_PROMPT = `You help a trucking company's shop work out which bought parts went into which repairs and services.

You get the items bought recently that aren't tied to any work yet (from parts-store receipts), and the work mechanics recorded around the same time: repairs, and services (PMs, oil changes, tire changes, battery changes). Parts are bought for the job, so every work entry is called a "repair" here. Repair notes are short and often in Spanish ("balatas" = brake shoes, "disco" = brake drum or rotor, "copiloto" = passenger side, "piloto" = driver side, "eje" = axle, "sellos" = seals, "ultimo eje" = last axle).

For each item, decide which repair it was used in, if any:
- Match by what the part is and what the repair says was fixed. A brake drum fits a repair that replaced drums or did brakes on that axle; a headlight fits a headlight repair.
- Services: an oil filter or fuel filter kit fits a PM or oil change on that truck (one of each per service); an air filter fits a service that changed it; a steer or drive tire fits a tire change at that position; a battery fits a battery change (as many as were changed).
- An item that says which truck it was bought for can only go to a repair on that truck. An item with "could be" trucks can only go to one of those.
- Dates: a part is bought the same day as the work or before it. Work done before the part was bought can't have used it (those pairs aren't listed). A receipt from the last few days may be for work not logged yet: when no listed work clearly fits, leave it out.
- A core charge goes to the same repair as the part it came with.
- One item line with a quantity of 2 or more can be split across repairs (give each part of the split as its own match with its qty).
- Leave an item out when no repair fits. Never force a match: a wrong match is worse than none.

confidence: 90+ only when the part clearly is what the repair replaced and the truck and dates fit; 60-89 when it fits but something is uncertain (two similar repairs, vague note, distant date); below 60 for a weak guess.`;

/**
 * The text for Claude: the open items and the repairs (with short refs) and
 * what the AI has been taught.
 * @param items open items (web/items.js openItems)
 * @param repairs serviceLog repair entries
 * @param names id -> unit name
 * @param uses all itemUses (to say what each repair already has and what admin rejected)
 * @returns { text, refs: { items: Map(ref -> item), repairs: Map(ref -> entry) } }
 */
export function matchContext(items, repairs, { names = new Map(), uses = [], allItems = items, memory = '' } = {}) {
  const itemRefs = new Map(items.map((it, i) => [`I${i + 1}`, it]));
  const repairRefs = new Map(repairs.map((e, i) => [`R${i + 1}`, e]));
  const refOfRepair = new Map([...repairRefs].map(([ref, e]) => [e.id, ref]));
  const byKey = new Map(allItems.map((it) => [it.key, it]));
  const name = (id) => names.get(id) ?? id;
  const money = (n) => (n == null ? '' : `, $${n.toFixed(2)} each`);
  const itemLines = [...itemRefs].map(([ref, it]) => {
    const truck = it.vehicleId ? `; bought for ${name(it.vehicleId)}` : it.truckChoices?.length ? `; could be ${it.truckChoices.map(name).join(' or ')}` : '';
    const no = usesFor(it.key, uses).filter((u) => u.status === 'rejected' && refOfRepair.has(u.logId)).map((u) => refOfRepair.get(u.logId));
    return `${ref}: ${it.kind === 'part' ? '' : `[${it.kind}] `}"${it.text}"${it.partNumber ? ` (${it.partNumber})` : ''} x${it.remaining}${money(it.unitCost)}, bought ${it.date} at ${it.vendor || '?'}${truck}${no.length ? `; admin said NOT ${no.join(', ')}` : ''}`;
  });
  const repairLines = [...repairRefs].map(([ref, e]) => {
    const has = uses.filter((u) => u.logId === e.id && ['auto', 'confirmed'].includes(u.status))
      .map((u) => byKey.get(itemKey(u.receiptId, u.lineId))?.text).filter(Boolean);
    return `${ref}: ${e.date} ${e.vehicleName ?? name(e.vehicleId)}${e.assetType === 'trailer' ? ' (trailer)' : ''}: "${repairText(e)}"${has.length ? `; already has: ${has.join(', ')}` : ''}`;
  });
  const text = [
    `Items not tied to any work yet:\n${itemLines.join('\n')}`,
    `Repairs recorded:\n${repairLines.join('\n')}`,
    memory,
    'Match the items to the repairs.',
  ].filter(Boolean).join('\n\n');
  return { text, refs: { items: itemRefs, repairs: repairRefs } };
}

// Repairs worth showing Claude: in the time window of at least one open item.
export const candidateRepairs = (items, repairs) => repairs.filter((e) => items.some((it) => inWindow(it, e)));

/**
 * Claude's answer -> new itemUses docs (without ids or timestamps).
 * Drops suggestions for unknown refs, repairs outside the item's window,
 * pairs admin already rejected, and more than the item has left. A
 * suggestion on a truck the item wasn't bought for (or not one of its
 * choices) can't count on its own. Sure ones (AUTO_CONFIDENCE+) count right
 * away ('auto'); the rest wait for admin ('doubt'), except for an item bought
 * in the last NEW_DAYS days: its work may not be logged yet, so an unsure
 * guess is dropped and it's asked again later.
 */
export function usesFromAnswer(answer, refs, { uses = [], names = new Map(), today = null } = {}) {
  const left = new Map([...refs.items.values()].map((it) => [it.key, it.remaining]));
  const out = [];
  for (const m of answer.matches ?? []) {
    const item = refs.items.get(m.item);
    const entry = refs.repairs.get(m.repair);
    if (!item || !entry || !inWindow(item, entry)) continue;
    if (usesFor(item.key, uses).some((u) => u.status === 'rejected' && u.logId === entry.id)) continue;
    const qty = Math.min(Number(m.qty) || 1, left.get(item.key));
    if (!(qty > 0)) continue;
    left.set(item.key, left.get(item.key) - qty);
    const allowed = item.vehicleId ? [item.vehicleId] : item.truckChoices ?? null;
    const offTruck = allowed && !allowed.includes(entry.vehicleId);
    let confidence = Math.max(0, Math.min(100, Math.round(Number(m.confidence) || 0)));
    if (offTruck) confidence = Math.min(confidence, 50);
    if (confidence < AUTO_CONFIDENCE && isNew(item, today)) { left.set(item.key, left.get(item.key) + qty); continue; }
    out.push({
      receiptId: item.receiptId,
      lineId: item.lineId,
      qty,
      logId: entry.id,
      vehicleId: entry.vehicleId,
      vehicleName: entry.vehicleName ?? names.get(entry.vehicleId) ?? null,
      assetType: entry.assetType === 'trailer' ? 'trailer' : 'truck',
      shop: false,
      by: 'ai',
      status: confidence >= AUTO_CONFIDENCE ? 'auto' : 'doubt',
      confidence,
      reason: offTruck ? `${m.reason} (Bought for a different truck.)` : m.reason,
      itemText: item.text,
      daysApart: daysBetween(item.date, entry.date),
    });
  }
  return out;
}

const isNew = (item, today) => Boolean(today && item.date && daysBetween(item.date, today) < NEW_DAYS);

// What the run looked at, to skip the next run when nothing changed. Which
// items are still new is part of it, so they're asked again once they aren't.
export const matchSignature = (items, repairs, today = null) => JSON.stringify([
  items.map((it) => `${it.key}x${it.remaining}${isNew(it, today) ? 'n' : ''}`).sort(),
  repairs.map((e) => e.id).sort(),
]);
