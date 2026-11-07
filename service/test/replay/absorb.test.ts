// Late-half absorption (absorb.ts). Load test `mixed` 04:12 UTC: halves of ONE action (identical occurredAt) were
// published further apart than the split hold, so 47/301 deals ended on labels_current "(unknown)" instead of "(none)"
// and late halves became extra change_log rows (e.g. deal 6212410158: REMOVED then LABEL_CHANGED "(unknown)" 7.7 s
// later, both occurredAt 04:11:08.896). Real Deal->Contact shapes: typeId 3 = unlabeled (HUBSPOT_DEFINED),
// 247 Decision maker, 249 Influencer, 251 Billing contact. An unlink = REMOVED 3 + REMOVED <label>, a labeled link =
// ADDED 3 + ADDED <label>, all with the IDENTICAL occurredAt.
//
// The journal is simulated with the real timing model: a file is published ~1.5 s after occurredAt (UUIDv7 offset =
// publish time) and becomes readable 2 s later; the worker reads every 3 s with the DEFAULT pairing config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/store/db.js';
import { StampQueue } from '../../src/worker/stamp-queue.js';
import type { TokenProvider } from '../../src/worker/tokens.js';
import { StoreLabelCache } from '../../src/core/labels.js';
import { DEFAULT_PAIRING_CONFIG } from '../../src/core/pairing.js';
import { runOnce, type JournalReadResult } from '../../src/core/poller.js';
import { recordKey, SENT_PREFIX, stampIdOf, type StampUpdate } from '../../src/core/stamp.js';
import { ADD, CONTACT, DEAL, ev, REM, T0, UD } from '../../src/core/testutil.js';
import { DEAL_CONTACT_LABELS, HD } from '../fixtures/deal-contact-labels.js';
import type { AssociationAction, JournalAssociationEntry, JournalFile } from '../../src/core/types.js';

const PORTAL = 1000001;
const DEFS = DEAL_CONTACT_LABELS;
const NAME: Record<number, string> = { 247: 'Decision maker', 249: 'Influencer', 251: 'Billing contact' };
const PUBLISH_DELAY = 1_500;
const VISIBLE_DELAY = 2_000;
const POLL = 3_000;

let seq = 0;
function uuid7(ms: number): string {
  const h = ms.toString(16).padStart(12, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;
}

type Order = 'structural first' | 'label first';
interface Action {
  kind: 'unlink' | 'link';
  dealId: number;
  contactId: number;
  label: number;
  /** occurredAt, ms after T0. */
  at: number;
  /** Publish gap between the two halves' files. */
  gap: number;
  order: Order;
}

const dealEv = (a: Pick<Action, 'dealId' | 'contactId'>, action: AssociationAction, typeId: number, at: number): JournalAssociationEntry =>
  ev({ portalId: PORTAL, action, typeId, category: typeId === 3 ? HD : UD, from: [DEAL, a.dealId], to: [CONTACT, a.contactId], at });

interface SimFile {
  pub: number;
  file: JournalFile;
}

function filesFor(a: Action): SimFile[] {
  const action = a.kind === 'unlink' ? REM : ADD;
  const [first, second] = a.order === 'structural first' ? [3, a.label] : [a.label, 3];
  const out: SimFile[] = [];
  const mk = (pub: number, evs: JournalAssociationEntry[]) => out.push({ pub, file: { offset: uuid7(pub), journalEvents: evs } });
  if (a.kind === 'unlink') {
    // The pair was linked with the label two minutes earlier (one whole file), so its label state is known.
    const at = a.at - 120_000;
    mk(T0 + at + PUBLISH_DELAY, [dealEv(a, ADD, 3, at), dealEv(a, ADD, a.label, at)]);
  }
  mk(T0 + a.at + PUBLISH_DELAY, [dealEv(a, action, first, a.at)]);
  mk(T0 + a.at + PUBLISH_DELAY + a.gap, [dealEv(a, action, second, a.at)]);
  return out;
}

interface SimResult {
  sent: StampUpdate[];
  /** Simulated HubSpot record properties after all stamps, per record key. */
  props: Map<string, Record<string, string>>;
  store: Store;
}

/**
 * Runs the worker over the simulated journal. 'immediate' = every stamp is sent at once (so a late half always finds
 * its change already stamped). 'deferred' = real StampQueue, drained only after the journal is done (so a late half
 * always finds its change still queued).
 */
async function simulate(actions: Action[], delivery: 'immediate' | 'deferred'): Promise<SimResult> {
  const store = new Store(':memory:');
  store.setWatchedPairs(PORTAL, [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  const files = actions.flatMap(filesFor).sort((x, y) => x.pub - y.pub || (x.file.offset < y.file.offset ? -1 : 1));
  const start = Math.min(...files.map((f) => f.pub));
  const end = Math.max(...files.map((f) => f.pub)) + 60_000;
  let now = start - 10_000;
  const labels = new StoreLabelCache(store, async (_p, f, t) => (f === DEAL && t === CONTACT ? DEFS : []), undefined, () => now);
  let next = 0;
  const readJournal = async (): Promise<JournalReadResult> => {
    const out: JournalFile[] = [];
    while (next < files.length && files[next].pub + VISIBLE_DELAY <= now) out.push(files[next++].file);
    return { files: out, nextOffset: out.at(-1)?.offset ?? null, full: false };
  };
  const sent: StampUpdate[] = [];
  const queue = new StampQueue({
    store,
    tokens: {} as TokenProvider,
    now: () => now,
    log: () => {},
    defaultSpacingMs: 3_000,
    drainInline: false,
    sendBatches: async (us) => {
      sent.push(...us);
      return us.map((update) => ({ update, ok: true as const }));
    },
  });
  const sendStamps =
    delivery === 'immediate'
      ? async (u: StampUpdate[], onDelivered: (d: StampUpdate[]) => void) => {
          sent.push(...u);
          // What the StampQueue does on success: remember which change each record shows.
          const normal = u.filter((x) => x.amendOf === undefined);
          store.setLastStampedChange(normal.map((x) => ({ recordKey: recordKey(x), changeId: stampIdOf(x) })), now);
          store.markSeen(normal.map((x) => SENT_PREFIX + stampIdOf(x)), now);
          onDelivered(u);
        }
      : (u: StampUpdate[], onDelivered: (d: StampUpdate[]) => void) => queue.sendStamps(u, onDelivered);
  for (now = start; now <= end; now += POLL) {
    await runOnce({ readJournal, sendStamps, store, labels, now: () => now });
  }
  assert.equal(store.loadPending().length, 0, 'nothing left on hold');
  if (delivery === 'deferred') {
    for (let i = 0; store.queueSize() > 0 && i < 10_000; i++) {
      now += 1_000;
      await queue.drain();
    }
    assert.equal(store.queueSize(), 0, 'queue drained');
  }
  const props = new Map<string, Record<string, string>>();
  for (const u of sent) {
    const k = recordKey(u);
    props.set(k, { ...(props.get(k) ?? {}), ...(u.properties as Record<string, string>) });
  }
  return { sent, props, store };
}

const dealKey = (a: Action) => `${PORTAL}|${DEAL}|${a.dealId}`;
const atIso = (a: Action) => new Date(T0 + a.at).toISOString();
/** Stamps that start a workflow (a new changecatch_last_change_id) for this action. */
const triggersFor = (r: SimResult, a: Action) =>
  r.sent.filter((u) => u.amendOf === undefined && recordKey(u) === dealKey(a) && u.occurredAtMs === T0 + a.at);
const amendsFor = (r: SimResult, a: Action) => r.sent.filter((u) => u.amendOf !== undefined && recordKey(u) === dealKey(a));
const logRows = (r: SimResult, a: Action) =>
  r.store.db
    .prepare('SELECT change_id, change_type, labels_current, superseded_by FROM change_log WHERE object_id = ? AND occurred_at = ? ORDER BY created_at, change_id')
    .all(String(a.dealId), atIso(a)) as { change_id: string; change_type: string; labels_current: string; superseded_by: string | null }[];
// Option values key labels by type id (`0-1:<typeId>`); NAME documents which label each id is.
const finalLabels = (a: Action) => (a.kind === 'unlink' ? 'none' : `0-1:${a.label}`);
const finalType = (a: Action) => (a.kind === 'unlink' ? 'REMOVED' : 'ADDED');

/** Checks every invariant for one action. Returns how many workflow triggers it caused. */
function check(r: SimResult, a: Action, delivery: 'immediate' | 'deferred'): number {
  const what = `${a.kind} ${a.order} gap ${a.gap / 1000}s deal ${a.dealId} (${delivery})`;
  const trig = triggersFor(r, a);
  const rows = logRows(r, a);
  const p = r.props.get(dealKey(a))!;
  // Final state on the record is right, and the record's change id is the action's last trigger.
  assert.equal(p.changecatch_labels_current, finalLabels(a), `final labels_current: ${what}`);
  assert.equal(p.changecatch_last_change_id, trig.at(-1)?.properties.changecatch_last_change_id, `last_change_id: ${what}`);
  assert.equal(p.changecatch_change_type, finalType(a), `final change type: ${what}`);
  // One change_log row per trigger: late halves never add rows of their own.
  assert.deepEqual(rows.map((x) => x.change_id), trig.map((u) => u.properties.changecatch_last_change_id), `change_log rows = triggers: ${what}`);
  assert.equal(rows.at(-1)?.change_type, finalType(a), `last change_log type: ${what}`);
  assert.equal(rows.at(-1)?.labels_current, finalLabels(a), `last change_log labels_current: ${what}`);
  // A REMOVED never says "(unknown)": an unlinked pair has no labels.
  for (const u of trig) if (u.properties.changecatch_change_type === 'REMOVED') assert.equal(u.properties.changecatch_labels_current, 'none', what);
  // Amend stamps only touch the label properties: never a new change id (no extra enrollment), never the type.
  for (const u of amendsFor(r, a)) {
    assert.deepEqual(Object.keys(u.properties).sort(), ['changecatch_labels_after', 'changecatch_labels_before', 'changecatch_labels_current'], what);
    assert.equal(u.amendOf, trig.at(-1)?.properties.changecatch_last_change_id, `amend targets the stamped change: ${what}`);
  }
  // Exactly ONE trigger, except a label-first split whose label half was ALREADY STAMPED before the structural half
  // arrived: a workflow may have run, so the structural change is emitted as its own change (new id, right type) and
  // the earlier row is marked superseded_by it. A missed "linked"/"unlinked" trigger is worse than a rare extra one.
  const labelFirstAfterStamp = delivery === 'immediate' && a.order === 'label first' && a.gap > DEFAULT_PAIRING_CONFIG.splitHoldMs;
  if (labelFirstAfterStamp) {
    assert.equal(trig.length, 2, `label-first after stamp -> LABEL_CHANGED then ${finalType(a)}: ${what}`);
    assert.equal(trig[0].properties.changecatch_change_type, 'LABEL_CHANGED', what);
    assert.notEqual(trig[1].properties.changecatch_last_change_id, trig[0].properties.changecatch_last_change_id, what);
    assert.equal(rows[0].superseded_by, trig[1].properties.changecatch_last_change_id, `earlier row superseded: ${what}`);
  } else {
    assert.equal(trig.length, 1, `exactly one trigger: ${what}`);
    for (const x of rows) assert.equal(x.superseded_by, null, what);
  }
  return trig.length;
}

// ---------- the matrix: gaps 2 / 10 / 30 / 90 s, both orders, unlink and link, both delivery timings ----------

const GAPS = [2_000, 10_000, 30_000, 90_000];
let id = 0;
for (const kind of ['unlink', 'link'] as const)
  for (const order of ['structural first', 'label first'] as const)
    for (const gap of GAPS)
      for (const delivery of ['immediate', 'deferred'] as const)
        test(`late half: ${kind}-with-label, ${order}, files ${gap / 1000} s apart, ${delivery} stamping`, async () => {
          const a: Action = { kind, dealId: 6212410158 + ++id, contactId: 185168 + id, label: 251, at: 0, gap, order };
          const r = await simulate([a], delivery);
          check(r, a, delivery);
          // Structural-first link past the hold: ADDED "(none)" first, then ONE amend to the label (immediate), or the
          // queued stamp is merged (deferred: no amend at all). Type corrections are never amends.
          if (kind === 'link' && order === 'structural first' && gap > DEFAULT_PAIRING_CONFIG.splitHoldMs) {
            assert.equal(amendsFor(r, a).length, delivery === 'immediate' ? 1 : 0);
          } else {
            assert.equal(amendsFor(r, a).length, 0);
          }
          r.store.close();
        });

test('real case deal 6212410158: unlink, REMOVED 3 first, label half 7.7 s later -> ONE REMOVED "(none)"', async () => {
  const a: Action = { kind: 'unlink', dealId: 6212410158, contactId: 185168, label: 251, at: 0, gap: 7_700, order: 'structural first' };
  const r = await simulate([a], 'immediate');
  assert.equal(check(r, a, 'immediate'), 1);
  assert.deepEqual(
    logRows(r, a).map((x) => [x.change_type, x.labels_current]),
    [['REMOVED', 'none']],
  );
  r.store.close();
});

// ---------- interleaved burst: 300 actions ----------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function burst(n: number, seed: number): Action[] {
  const r = rng(seed);
  const labels = [247, 249, 251];
  return Array.from({ length: n }, (_, i) => ({
    kind: r() < 0.5 ? 'unlink' : 'link',
    dealId: 6300000000 + i,
    contactId: 190000 + i,
    label: labels[Math.floor(r() * 3)],
    at: Math.floor(r() * 60_000), // 300 actions in one minute, interleaved
    gap: GAPS[Math.floor(r() * GAPS.length)],
    order: r() < 0.5 ? 'structural first' : 'label first',
  }));
}

for (const delivery of ['immediate', 'deferred'] as const) {
  test(`interleaved burst of 300 split actions (${delivery} stamping): right final labels, no extra rows`, async () => {
    const actions = burst(300, delivery === 'immediate' ? 42 : 7);
    const r = await simulate(actions, delivery);
    let triggers = 0;
    for (const a of actions) triggers += check(r, a, delivery);
    const doubles = actions.filter((a) => delivery === 'immediate' && a.order === 'label first' && a.gap > DEFAULT_PAIRING_CONFIG.splitHoldMs).length;
    assert.equal(triggers, actions.length + doubles);
    const prior = actions.filter((a) => a.kind === 'unlink').length; // the earlier labeled links of the unlinked pairs
    const total = Number((r.store.db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n);
    assert.equal(total, prior + triggers, 'change_log has no rows for late halves');
    r.store.close();
  });
}
