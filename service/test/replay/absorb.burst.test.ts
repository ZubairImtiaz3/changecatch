// Regression tests replaying a real load-test `mixed` run of 2026-10-30 04:30 UTC (journal events + worker
// log). Real Deal->Contact types: 3 = unlabeled (HUBSPOT_DEFINED), 247 Decision maker,
// 249 Influencer. Three bugs, all on real event sequences:
//
//  1. Wrong labels (7/50) + extra rows (14): the burst relabel was a SWAP whose halves had DIFFERENT occurredAts
//     (ADDED 247 @ 04:30:37.289, REMOVED 249 @ 04:30:38.131) and landed in different journal files. Each half became
//     its own LABEL_CHANGED, e.g. contact 134301: "Influencer -> (none)" then "(none) -> Decision maker".
//  2. Extra rows (31 burst + 16 spread): label-first splits of ONE action (identical occurredAt) were "converted" by
//     emitting a SECOND change whenever the first one was no longer queued: burst contact 183201 (ADDED 249, then
//     ADDED 3 ~6 s later, both @ 25.104) even though its LABEL_CHANGED had only been coalesced away, never stamped;
//     spread deal 6610028205 (REMOVED 249, then REMOVED 3 3.4 s later, both @ 37.631) after it was stamped.
//  3. Final burst stamp 278.6 s late: ~30 amend stamps (one per late label half, for changes that had been coalesced
//     away) queued on the burst deal, and the drain's per-record order (created_at) disagreed with the slot planner's
//     (stamp id), so they kept pushing each other back; then every amend took its own 3 s spacing slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/store/db.js';
import { DEFAULT_RETRY_WINDOW_MS } from '../../src/worker/stamp-queue.js';
import { DEFAULT_STAMP_SPACING_SECONDS } from '../../src/store/schema.js';
import { StampQueue } from '../../src/worker/stamp-queue.js';
import { stampIdOf, type StampUpdate } from '../../src/core/stamp.js';
import type { AssociationAction, JournalFile } from '../../src/core/types.js';
import { ADD, CONTACT, DEAL, ev, HD, REM, T0, UD, uuid7 } from '../fixtures/journal.js';
import { DEAL_CONTACT_LABELS } from '../fixtures/labels.js';
import { memoryLogger } from '../fixtures/log.js';
import { replay, type Rig } from '../fixtures/replay.js';
import type { LoggedChange } from '../../src/store/change-log.js';

const PORTAL = 1000001;
const SPACING = 3_000; // the default spacing (StampQueue, settings page)

/** One journal event: occurredAt (ms after T0) and the publish time of the file it is in (ms after T0). */
interface E {
  deal: number;
  contact: number;
  action: AssociationAction;
  typeId: number;
  at: number;
  pub: number;
}
const e = (deal: number, contact: number, action: AssociationAction, typeId: number, at: number, pub: number): E => ({ deal, contact, action, typeId, at, pub });

type Sim = Rig & { props: Map<string, Record<string, string>> };

/**
 * Runs the worker like production: read every 3 s, real StampQueue (3 s spacing, coalescing 'latest') drained every
 * second, HubSpot accepts every stamp.
 */
async function simulate(events: E[]): Promise<Sim> {
  const byPub = new Map<number, E[]>();
  for (const x of events) (byPub.get(x.pub) ?? byPub.set(x.pub, []).get(x.pub)!).push(x);
  const files: { pub: number; file: JournalFile }[] = [...byPub.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pub, xs]) => ({
      pub: T0 + pub,
      file: {
        offset: uuid7(T0 + pub),
        journalEvents: xs.map((x) =>
          ev({ portalId: PORTAL, action: x.action, typeId: x.typeId, category: x.typeId === 3 ? HD : UD, from: [DEAL, x.deal], to: [CONTACT, x.contact], at: x.at }),
        ),
      },
    }));
  const rig = await replay({
    portal: PORTAL, labels: DEAL_CONTACT_LABELS, files, start: files[0].pub - 5_000, end: files.at(-1)!.pub + 120_000,
    tickMs: 1_000, readEvery: 3, delivery: 'queue',
  });
  return Object.assign(rig, { props: rig.props() });
}

const rowsFor = (s: Sim, deal: number, contact: number) => s.loggedChanges([deal]).filter((r) => r.otherRecordId === String(contact));
const shape = (rs: LoggedChange[]) => rs.map((r) => `${r.changeType} ${r.labelBefore} -> ${r.labelAfter} [${r.labelsCurrent}]`);
const triggers = (s: Sim, deal: number) => s.sent.filter((u) => u.amendOf === undefined && u.objectId === String(deal));

const INF = '0-1:249'; // Influencer (option value = type id)
const DM = '0-1:247'; // Decision maker

// ---------------------------------------------------------------- bug 1: split label swap, different occurredAt

for (const [name, contact, first, second] of [
  // contact 134301: REMOVED 249 @ 38.131 was read first -> "Influencer -> (none)", then "(none) -> Decision maker".
  ['REMOVED Influencer first (contact 134301)', 134301, e(0, 0, REM, 249, 38_131, 39_600), e(0, 0, ADD, 247, 37_289, 47_000)],
  // contact 178137: ADDED 247 @ 37.289 first -> "Influencer -> DM; Influencer", then "DM; Influencer -> DM".
  ['ADDED Decision maker first (contact 178137)', 178137, e(0, 0, ADD, 247, 37_289, 38_800), e(0, 0, REM, 249, 38_131, 47_000)],
] as const) {
  test(`04:30 relabel split over 2 files, halves 842 ms apart, ${name}: ONE "Influencer -> Decision maker"`, async () => {
    const deal = 5000000001;
    const s = await simulate([
      e(deal, contact, ADD, 3, 0, 1_500),
      e(deal, contact, ADD, 249, 0, 1_500),
      { ...first, deal, contact },
      { ...second, deal, contact },
      e(deal, contact, REM, 3, 50_000, 51_500),
      e(deal, contact, REM, 247, 50_000, 51_500),
    ]);
    assert.deepEqual(shape(rowsFor(s, deal, contact)), [
      `ADDED none -> ${INF} [${INF}]`,
      `LABEL_CHANGED ${INF} -> ${DM} [${DM}]`,
      `REMOVED ${DM} -> none [none]`,
    ]);
    assert.equal(triggers(s, deal).length, 3, 'one workflow trigger per user action');
    assert.equal(s.props.get(`${PORTAL}|${DEAL}|${deal}`)!.changecatch_labels_current, 'none');
    s.store.close();
  });
}

test('a relabel is never merged with a link/unlink that has a different occurredAt', async () => {
  // Link @ 0, then (1 s later, inside the 2 s pairing window) a label added on its own, arriving in a late file.
  const deal = 6610000001;
  const contact = 186001;
  const s = await simulate([
    e(deal, contact, ADD, 3, 0, 1_500),
    e(deal, contact, ADD, 249, 0, 1_500),
    e(deal, contact, ADD, 247, 1_000, 12_000),
  ]);
  assert.deepEqual(shape(rowsFor(s, deal, contact)), [`ADDED none -> ${INF} [${INF}]`, `LABEL_CHANGED ${INF} -> ${DM};${INF} [${DM};${INF}]`]);
  s.store.close();
});

// ---------------------------------------------------------------- bug 2: label-first split of ONE action

test('04:30 spread deal 6610028205: REMOVED 249, REMOVED 3 later (both @ 37.631), label half ALREADY STAMPED -> a NEW REMOVED change', async () => {
  const deal = 6610028205;
  const contact = 186167;
  const s = await simulate([
    e(deal, contact, ADD, 3, 0, 1_500),
    e(deal, contact, ADD, 249, 0, 1_500),
    e(deal, contact, REM, 249, 13_061, 14_500),
    e(deal, contact, REM, 3, 13_061, 24_900), // 10.4 s later: well after the label half was stamped
  ]);
  const rows = rowsFor(s, deal, contact);
  // The stamped LABEL_CHANGED stays as it was (a workflow may have run on it), marked superseded by the new REMOVED.
  assert.deepEqual(
    shape(rows).sort(),
    [`ADDED none -> ${INF} [${INF}]`, `LABEL_CHANGED ${INF} -> none [none]`, `REMOVED ${INF} -> none [none]`].sort(),
  );
  const lc = rows.find((r) => r.changeType === 'LABEL_CHANGED')!;
  const removed = rows.find((r) => r.changeType === 'REMOVED')!;
  assert.notEqual(removed.changeId, lc.changeId, 'new change id');
  const sup = s.loggedChanges([deal]).filter((x) => x.supersededBy !== null);
  assert.deepEqual(sup.map((x) => [x.changeId, x.supersededBy]), [[lc.changeId, removed.changeId]]);
  // 3 triggers: link, the stamped LABEL_CHANGED, and the REMOVED ("unlinked" workflows fire). No type-changing amend.
  const trig = triggers(s, deal);
  assert.deepEqual(trig.map((u) => u.properties.changecatch_change_type), ['ADDED', 'LABEL_CHANGED', 'REMOVED']);
  assert.equal(s.sent.filter((u) => u.amendOf !== undefined).length, 0);
  const p = s.props.get(`${PORTAL}|${DEAL}|${deal}`)!;
  assert.equal(p.changecatch_change_type, 'REMOVED');
  assert.equal(p.changecatch_labels_current, 'none');
  assert.equal(p.changecatch_last_change_id, removed.changeId);
  s.store.close();
});

test('label-first unlink split whose label half is still QUEUED -> converted in place: ONE REMOVED, same id', async () => {
  const deal = 6610028206;
  const contact = 186168;
  // Other links on the deal just before keep the label half's stamp queued (3 s spacing) until the structural half.
  // 2 others + the label half = 3 pending on the deal: at the coalescing threshold, so nothing is folded.
  const others = Array.from({ length: 2 }, (_, i) => 186200 + i);
  const s = await simulate(
    [
      ...others.flatMap((c) => [e(deal, c, ADD, 3, 12_000, 13_000), e(deal, c, ADD, 249, 12_000, 13_000)]),
      e(deal, contact, ADD, 3, 0, 1_500),
      e(deal, contact, ADD, 249, 0, 1_500),
      e(deal, contact, REM, 249, 13_061, 14_500),
      e(deal, contact, REM, 3, 13_061, 17_000),
    ],
  );
  assert.deepEqual(shape(rowsFor(s, deal, contact)), [`ADDED none -> ${INF} [${INF}]`, `REMOVED ${INF} -> none [none]`]);
  assert.deepEqual(s.loggedChanges([deal]).filter((x) => x.supersededBy !== null), []);
  s.store.close();
});

// ---------------------------------------------------------------- bugs 2 + 3: the burst deal

test('04:30 burst deal 5000000001: 300 links, 50 split relabels, 31 label-first link splits, unlink all -> 650 rows, fast final stamp', async () => {
  const deal = 5000000001;
  const contacts = Array.from({ length: 300 }, (_, i) => 178000 + i);
  const evs: E[] = [];
  const batches = [
    { at: 0, pub: 1_400, from: 0, to: 100 },
    { at: 930, pub: 2_300, from: 100, to: 200 },
    { at: 1_920, pub: 3_300, from: 200, to: 300 },
  ];
  for (const b of batches)
    for (let i = b.from; i < b.to; i++) {
      // 31 contacts (like 183201): the label half came first, the structural half ~6 s later (identical occurredAt).
      const split = i % 10 === 3 && i < 310;
      evs.push(e(deal, contacts[i], ADD, 249, b.at, b.pub));
      evs.push(e(deal, contacts[i], ADD, 3, b.at, split ? b.pub + 6_000 : b.pub));
    }
  const rel = contacts.slice(0, 50);
  rel.forEach((c, i) => {
    // 36 relabels in one file; 14 split (7 REMOVED-first, 7 ADDED-first), halves 842 ms apart.
    const split = i >= 36;
    const remFirst = i >= 43;
    evs.push(e(deal, c, ADD, 247, 13_115, split && remFirst ? 23_000 : 15_000));
    evs.push(e(deal, c, REM, 249, 13_957, split && !remFirst ? 23_000 : 15_400));
  });
  const unlinkAt = 25_287;
  for (const c of contacts) {
    evs.push(e(deal, c, REM, 3, unlinkAt, 27_000));
    evs.push(e(deal, c, REM, rel.includes(c) ? 247 : 249, unlinkAt, 27_000));
  }
  const s = await simulate(evs);

  const total = s.loggedChanges([deal]).length;
  assert.equal(total, 650, '300 links + 50 relabels + 300 unlinks, no rows for late halves');
  for (const c of contacts) {
    const r = shape(rowsFor(s, deal, c));
    const expected = rel.includes(c)
      ? [`ADDED none -> ${INF} [${INF}]`, `LABEL_CHANGED ${INF} -> ${DM} [${DM}]`, `REMOVED ${DM} -> none [none]`]
      : [`ADDED none -> ${INF} [${INF}]`, `REMOVED ${INF} -> none [none]`];
    assert.deepEqual(r, expected, `contact ${c}`);
  }
  // Final stamp = the last change, with the right labels.
  const p = s.props.get(`${PORTAL}|${DEAL}|${deal}`)!;
  assert.equal(p.changecatch_change_type, 'REMOVED');
  assert.equal(p.changecatch_labels_current, 'none');
  const lastRow = s.loggedChanges([deal]).filter((r) => r.changeType === 'REMOVED').at(-1)!;
  assert.equal(p.changecatch_last_change_id, lastRow.changeId);
  // No amend stamps for changes the record never showed (coalesced away), and no stamp waits behind a pile of them.
  const amends = s.sent.filter((u) => u.amendOf !== undefined);
  assert.ok(amends.length <= 1, `at most one amend on the burst record, got ${amends.length}`);
  const deliveredAt = s.sentAt.get(lastRow.changeId)!;
  const waited = deliveredAt - (T0 + unlinkAt);
  // Published at +1.7 s, visible at +3.7 s, read <= 3 s later; only a handful of slots can be ahead of it.
  assert.ok(waited <= 20_000, `final stamp ${waited / 1000} s after the unlink (was 278.6 s)`);
  s.store.close();
});

// ---------------------------------------------------------------- bug 3 in isolation: queue order

test('stamp queue: drain order = slot-planner order, so a record with many queued stamps never livelocks', async () => {
  const store = new Store(':memory:');
  let now = T0;
  const sent: { id: string; at: number }[] = [];
  const queue = new StampQueue({
    store,
    revoked: { listRevoked: () => [] },
    spacingFor: () => DEFAULT_STAMP_SPACING_SECONDS * 1000,
    retryWindowMs: DEFAULT_RETRY_WINDOW_MS,
    now: () => now,
    log: memoryLogger().log,
    sendBatches: async (us) => {
      for (const u of us) sent.push({ id: stampIdOf(u), at: now });
      return us.map((update) => ({ update, kind: 'ok' as const }));
    },
  });
  const base = { portalId: PORTAL, objectTypeId: DEAL, objectId: '5000000001' };
  const normal = (id: string, at: number): StampUpdate => ({ ...base, occurredAtMs: at, properties: { changecatch_last_change_id: id } });
  const amend = (of: string, at: number): StampUpdate => ({
    ...base, occurredAtMs: at, amendOf: of, stampId: `${of}~amend-x`, properties: { changecatch_labels_current: INF },
  });
  const occ = T0 - 13_000;
  // The real shape: the record's one queued change "...-fc1f73d382" was created first; then amend stamps with the SAME
  // occurredAt whose ids sort BEFORE it ("...-0c39...~amend") arrived, while the burst kept adding newer changes.
  queue.enqueue([normal('1793334626094-fc1f73d382', occ)]);
  now += 6_000;
  queue.enqueue(['0c39a5aeac', '10a09389eb', '1be8d391df', '22cfb6ecc8', '263327552d'].map((h) => amend(`1793334626094-${h}`, occ)));
  for (let i = 0; i < 40; i++, now += 1_000) {
    if (i % 3 === 0 && i < 30) queue.enqueue([normal(`1793334649${String(400 + i).padStart(3, '0')}-ffffffffff`, T0 + i * 100)]);
    await queue.drain();
  }
  for (; store.stamps.queueSize() > 0 && now < T0 + 600_000; now += 1_000) await queue.drain();
  assert.equal(store.stamps.queueSize(), 0);
  // Every stamp goes out in planner order, one spacing slot after the previous one: no stamp waits longer than its
  // queue position x spacing (the old created_at order livelocked here while enqueues kept coming).
  const ids = sent.map((x) => x.id);
  assert.equal(ids.indexOf('1793334626094-fc1f73d382'), 5, ids.join(', '));
  for (let i = 1; i < sent.length; i++) {
    const gap = sent[i].at - sent[i - 1].at;
    assert.ok(gap >= SPACING && gap <= SPACING + 1_000, `gap ${gap} ms before ${sent[i].id}`);
  }
  assert.ok(sent[5].at - T0 <= 6_000 + 6 * SPACING, `fc1f sent ${(sent[5].at - T0) / 1000} s after the start`);
  store.close();
});
