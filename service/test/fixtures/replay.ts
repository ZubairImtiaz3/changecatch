// Replays journal files through the worker on a fake clock (test/replay/*). The worker is built as production builds it
// (buildWorker, through workerHarness): label guard, option-sync hook, stamp queue and CRM batch update are the real
// wiring with faked HubSpot parts. HubSpot's dropdown options are simulated: every drain asserts that each stamped
// dropdown value was an option.
import assert from 'node:assert/strict';
import { recordKey } from '../../src/core/keys.js';
import type { LabelFetcher } from '../../src/core/labels.js';
import type { RunDeps, RunResult } from '../../src/core/poller.js';
import { stampIdOf, type StampUpdate } from '../../src/core/stamp.js';
import type { LabelDefinition, WatchedPair } from '../../src/core/types.js';
import { CUSTOM_READ_SCOPES, CUSTOM_WRITE_SCOPES } from '../../src/core/pairs.js';
import type { Env } from '../../src/lib/config.js';
import { CONTACT, DEAL, timedJournal, type TimedFile } from './journal.js';
import { workerHarness } from './worker.js';

export interface RigOpts {
  portal: number;
  /** Deal -> Contact definitions, or a fetcher for any pair. */
  labels: LabelDefinition[] | LabelFetcher;
  /** Default: Deal -> Contact. */
  pairs?: WatchedPair[];
  /**
   * 'immediate' = the portal's stamp spacing is 0 and the queue is drained right after every read, so each stamp is
   * out before the next read; 'queue' = the default spacing, call queue.drain().
   */
  delivery: 'immediate' | 'queue';
  /** Worker config variables (PAIRING_SPLIT_HOLD_MS, STAMP_MIRROR, ...). */
  env?: Env;
  clock?: { t: number };
}

/** The worker for one portal; `run` is one journal read (Worker.readOnce), `queue.drain` one queue cycle. */
export function replayRig(o: RigOpts) {
  const clock = o.clock ?? { t: 0 };
  const defs = o.labels;
  const fetchLabels: LabelFetcher = typeof defs === 'function' ? defs : async (_p, f, t) => (f === DEAL && t === CONTACT ? defs : []);
  let readNow: RunDeps['readJournal'] = async () => ({ files: [], nextOffset: null, full: false });
  const h = workerHarness({
    dbPath: ':memory:',
    clock,
    env: o.env,
    installed: [o.portal],
    // Custom read + write granted (Enterprise), so custom-object pairs are active (core/pairs.ts portalPairs).
    scopes: [...CUSTOM_READ_SCOPES, ...CUSTOM_WRITE_SCOPES],
    pairs: o.pairs ?? [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }],
    fetchLabels,
    readJournal: (after) => readNow(after),
  });
  if (o.delivery === 'immediate') h.portals.setStampSpacingSeconds(o.portal, 0, clock.t);
  const sent: StampUpdate[] = [];
  /** Clock time each stamp (by stamp id) was sent. */
  const sentAt = new Map<string, number>();
  const drain = async () => {
    const r = await h.queue.drain();
    for (const u of r.sent) sentAt.set(stampIdOf(u), clock.t);
    sent.push(...r.sent);
    assert.deepEqual(h.invalidOptions, [], 'every stamped dropdown value is an option in HubSpot');
    assert.deepEqual(r.dropped, [], 'no stamp dead-lettered');
    return r;
  };
  return {
    store: h.store,
    clock,
    labels: h.labels,
    options: h.options,
    sent,
    sentAt,
    queue: { drain },
    async run(readJournal: RunDeps['readJournal']): Promise<RunResult> {
      readNow = readJournal;
      const r = await h.worker.readOnce();
      if (!r) throw new Error(`journal run failed: ${h.store.journal.getLastError()?.message}`);
      if (o.delivery === 'immediate') for (let i = 0; (h.store.stamps.nextDueAt() ?? Infinity) <= clock.t && i < 1_000; i++) await drain();
      return r;
    },
    /** change_log rows of these deals, by occurredAt then change id. */
    loggedChanges: (dealIds: (number | string)[]) =>
      h.store.changes.changesForRecords(o.portal, DEAL, dealIds.map(String), 0).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.changeId.localeCompare(b.changeId)),
    /** Simulated HubSpot record properties after all stamps, per record key. */
    props() {
      const out = new Map<string, Record<string, string>>();
      for (const u of sent) {
        const k = recordKey(u);
        out.set(k, { ...(out.get(k) ?? {}), ...(u.properties as Record<string, string>) });
      }
      return out;
    },
  };
}

export type Rig = ReturnType<typeof replayRig>;

export interface ReplayOpts extends Omit<RigOpts, 'delivery' | 'clock'> {
  files: TimedFile[];
  start: number;
  end: number;
  tickMs: number;
  /** Read the journal every N ticks (first read on the first tick). Default 1. */
  readEvery?: number;
  /** A file becomes readable this long after it was published. Default 2 s. */
  visibleDelayMs?: number;
  /** 'immediate'; 'queue' = drained every tick; 'queue-at-end' = drained only after the journal (every second). */
  delivery: 'immediate' | 'queue' | 'queue-at-end';
}

/** Runs the worker over timed journal files from `start` to `end`; afterwards nothing is held and the queue is empty. */
export async function replay(o: ReplayOpts): Promise<Rig> {
  const rig = replayRig({ ...o, delivery: o.delivery === 'immediate' ? 'immediate' : 'queue', clock: { t: o.start } });
  const readJournal = timedJournal(o.files, () => rig.clock.t, o.visibleDelayMs ?? 2_000);
  for (let i = 0; rig.clock.t <= o.end; i++, rig.clock.t += o.tickMs) {
    if (i % (o.readEvery ?? 1) === 0) await rig.run(readJournal);
    if (o.delivery === 'queue') await rig.queue.drain();
  }
  assert.equal(rig.store.entries.loadPending().length, 0, 'nothing left on hold');
  if (o.delivery === 'queue-at-end')
    for (let i = 0; rig.store.stamps.queueSize() > 0 && i < 10_000; i++) {
      rig.clock.t += 1_000;
      await rig.queue.drain();
    }
  assert.equal(rig.store.stamps.queueSize(), 0, 'queue drained');
  return rig;
}
