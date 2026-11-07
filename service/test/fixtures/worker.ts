// The worker as production wires it (buildWorker, worker/main.ts), with HubSpot and the clock faked:
// real Store + PortalStore on one SQLite database, real PortalTokenProvider / Lifecycle / StampQueue /
// label guard + option-sync hook, fake journal, label definitions, CRM batch update, subscriptions and dropdown options.
// Config = loadConfig defaults + `env`.
//
// Dropdown options (FakeOptions): HubSpot's option lists per portal + object type, as provisioning leaves them plus what
// the (fake) option sync added. The fake CRM batch update refuses a value that is not an option the way HubSpot does,
// and records it; close() fails the test if any was stamped (unless expectInvalidOptions).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANGECATCH_PROPERTIES, LABEL_PROPERTY_NAMES, STAMP_PROPS, SYNCED_ENUM_PROPERTY_NAMES } from '../../src/core/contract.js';
import { desiredSyncedOptions, otherTypesFor, splitValues, type LabelSource } from '../../src/core/label-options.js';
import type { LabelFetcher } from '../../src/core/labels.js';
import type { RunDeps } from '../../src/core/poller.js';
import type { JournalFile, WatchedPair } from '../../src/core/types.js';
import { PortalTokenProvider } from '../../src/hubspot/portal-tokens.js';
import type { LabelSyncReport, SyncLabelOptions } from '../../src/hubspot/properties.js';
import type { BatchError } from '../../src/hubspot/batch.js';
import type { BatchUpdateResponse } from '../../src/hubspot/stamp.js';
import { loadConfig, type Env } from '../../src/lib/config.js';
import type { Heartbeat } from '../../src/obs/heartbeat.js';
import type { Logger } from '../../src/obs/log.js';
import { ChangeCatchMetrics } from '../../src/obs/metrics.js';
import { Store } from '../../src/store/db.js';
import { PortalStore } from '../../src/store/portals.js';
import { portalPairs } from '../../src/core/pairs.js';
import { parseKeyring } from '../../src/lib/crypto.js';
import { buildWorker, type Worker } from '../../src/worker/main.js';
import { CONTACT, DEAL, fakeJournal, T0 } from './journal.js';
import { LABELS } from './labels.js';
import { memoryLogger } from './log.js';
import { FakeSubs } from './subscriptions.js';

export interface WorkerHarnessOpts {
  /** Journal content (fakeJournal). */
  files?: JournalFile[];
  /** Replaces the fake journal; calls are still logged in `reads`. */
  readJournal?: RunDeps['readJournal'];
  /** Reuse this database file (restart tests; the caller deletes it), or ':memory:'. Default: a fresh temp file, deleted by close(). */
  dbPath?: string;
  clock?: { t: number };
  /** Config variables on top of the defaults (JOURNAL_POLL_MS, STAMP_MIRROR, ...). */
  env?: Env;
  /** Portals installed (with a token). Default [111]. */
  installed?: number[];
  /** Scopes the installed portals granted. Default none (custom-object pairs are then inactive, as in production). */
  scopes?: string[];
  /** Portals watching `pairs`. Default: the installed ones. */
  watched?: number[];
  /** Pairs the watched portals save. Default: Deal -> Contact. */
  pairs?: WatchedPair[];
  /** Label definitions. Default: LABELS for every pair. */
  fetchLabels?: LabelFetcher;
  /** Called before each (fake) option sync of (portal, object type); throw to fail that sync. */
  beforeSync?: (portalId: number, objectTypeId: string) => void;
  /** The test makes HubSpot refuse values on purpose: close() does not fail on stamped values that are not options. */
  expectInvalidOptions?: boolean;
  /** CRM batch update answer for call `n`; undefined = HubSpot's answer (ok, or refused for a value that is not an option); throw to fail the call. */
  respond?: (n: number, ids: string[]) => BatchUpdateResponse | undefined;
  log?: Logger;
  pulse?: Pick<Heartbeat, 'ok' | 'fail'>;
  /** true = the production sleep (real timer, woken by stop()). Default: fake-clock sleep. */
  realSleep?: boolean;
  /** OAuth refresh-token call. Default: always a fresh access token. */
  refresh?: ConstructorParameters<typeof PortalTokenProvider>[0]['refresh'];
}

export type WorkerHarness = ReturnType<typeof workerHarness>;

export function workerHarness(o: WorkerHarnessOpts = {}) {
  const dir = o.dbPath ? null : mkdtempSync(join(tmpdir(), 'cc-worker-'));
  const dbPath = o.dbPath ?? join(dir!, 'db.sqlite');
  const config = loadConfig('worker', {
    HUBSPOT_CLIENT_ID: 'id',
    HUBSPOT_CLIENT_SECRET: 'secret',
    TOKEN_ENC_KEYS: `t:${randomBytes(32).toString('base64')}`,
    DB_PATH: dbPath,
    ...o.env,
  });
  const clock = o.clock ?? { t: T0 + 60_000 };
  const now = () => clock.t;
  const log = o.log ?? memoryLogger().log;
  const store = new Store(dbPath);
  const portals = new PortalStore({ db: store.conn, key: config.tokenKey });
  const installed = o.installed ?? [111];
  for (const p of installed) portals.saveInstall(p, `rt-${p}`, o.scopes ?? [], T0 - 60_000);
  for (const p of o.watched ?? installed) portals.setWatchedPairs(p, o.pairs ?? [{ objectTypeId: DEAL, associatedObjectTypeId: CONTACT }]);
  const tokens = new PortalTokenProvider({
    store: portals,
    refresh: o.refresh ?? (async () => ({ token_type: 'bearer', access_token: 'tok', expires_in: 1800 })),
    logger: log,
    now,
  });
  const subs = new FakeSubs();
  const metrics = new ChangeCatchMetrics();
  const fetchLabels = o.fetchLabels ?? (async () => LABELS);
  const options = new FakeOptions();
  /** Stamped values HubSpot refused because they are not options. */
  const invalidOptions: string[] = [];

  /** CRM batch updates: record ids, clock time, change types, stamped properties. */
  const calls: { ids: string[]; at: number; types: string[]; props: Record<string, string>[] }[] = [];
  const journal = fakeJournal(o.files ?? []);
  const reads = journal.reads;
  let fromStart = false; // rereadFromStart()
  const readJournal: RunDeps['readJournal'] = async (after) => {
    if (fromStart) [fromStart, after] = [false, null];
    if (!o.readJournal) return journal.readJournal(after);
    reads.push(after);
    return o.readJournal(after);
  };

  // Fake-clock sleep for loop tests: advances the clock, records each wake-up, stops at `until`.
  const wakes: number[] = [];
  let until = Infinity;
  let worker!: Worker;
  const built = buildWorker(config.worker, {
    store,
    portals,
    tokens,
    subscriptions: subs,
    readJournal,
    fetchLabels,
    syncLabels: fakeOptionSync(fetchLabels, options, o.beforeSync),
    batchUpdate: async (auth, type, inputs) => {
      calls.push({ ids: inputs.map((i) => i.id), at: clock.t, types: inputs.map((i) => i.properties.changecatch_change_type), props: inputs.map((i) => i.properties) });
      const custom = o.respond?.(calls.length, inputs.map((i) => i.id));
      if (custom) return custom;
      const errors: BatchError[] = [];
      for (const i of inputs) {
        const bad = options.invalid(auth.portalId, type, i.properties);
        if (!bad.length) continue;
        invalidOptions.push(...bad.map((b) => `portal ${auth.portalId} ${type}/${i.id} ${b}`));
        errors.push(invalidOptionError(i.id, bad[0]));
      }
      const failed = new Set(errors.map((e) => (e.context?.ids as string[])[0]));
      return {
        status: 'COMPLETE',
        results: inputs.filter((i) => !failed.has(i.id)).map((i) => ({ id: i.id })),
        ...(errors.length ? { errors, numErrors: errors.length } : {}),
      };
    },
    metrics,
    log,
    pulse: o.pulse,
    now,
    sleep: o.realSleep
      ? undefined
      : async (ms) => {
          clock.t += ms;
          wakes.push(clock.t);
          if (clock.t >= until) void worker.stop();
        },
  });
  worker = built.worker;
  const close = () => {
    if (!open.delete(close)) return;
    store.close();
    portals.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!o.expectInvalidOptions) assert.deepEqual(invalidOptions, [], 'every stamped dropdown value is an option in HubSpot');
  };
  open.add(close);

  return {
    ...built,
    store,
    portals,
    tokens,
    subs,
    metrics,
    clock,
    calls,
    reads,
    wakes,
    options,
    invalidOptions,
    /** One loop iteration as production runs it: read the journal, then send what is due. */
    async step() {
      const r = await worker.readOnce();
      await worker.drainQueue();
      return r;
    },
    /** The next journal read starts at the beginning of the journal, as after a lost offset. */
    rereadFromStart() {
      fromStart = true;
    },
    /** Run the loop (fake clock) until the clock reaches `t`. */
    async runUntil(t: number) {
      until = t;
      await worker.run();
    },
    close,
  };
}

/**
 * Watched pairs exactly as the worker computes them (buildWorker: core/pairs.ts portalPairs(...).active), for tests
 * that drive runOnce directly. `portals` shares `store`'s connection: set pairs and installs through it.
 */
export function activePairsOn(store: Store): { portals: PortalStore; watchedPairs: (portalId: number) => WatchedPair[] } {
  const portals = new PortalStore({ db: store.conn, key: parseKeyring(`t:${randomBytes(32).toString('base64')}`) });
  return { portals, watchedPairs: (p) => portalPairs(portals, p).active };
}

const open = new Set<() => void>();
/** Close every harness still open (use as afterEach). Throws the first close() failure after closing them all. */
export function closeWorkerHarnesses(): void {
  const errors: unknown[] = [];
  for (const close of open) {
    try {
      close();
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length) throw errors[0];
}

// ---------------------------------------------------------------- dropdown options

/** HubSpot's options per portal + object type + dropdown. A list starts as provisioning creates it (core/contract.ts). */
export class FakeOptions {
  private readonly lists = new Map<string, Set<string>>();

  private list(portalId: number, objectTypeId: string, prop: string): Set<string> {
    const k = `${portalId}|${objectTypeId}|${prop}`;
    let l = this.lists.get(k);
    if (!l) {
      l = new Set((CHANGECATCH_PROPERTIES.find((d) => d.name === prop)?.options ?? []).map((x) => x.value));
      this.lists.set(k, l);
    }
    return l;
  }
  add(portalId: number, objectTypeId: string, prop: string, values: string[]): void {
    const l = this.list(portalId, objectTypeId, prop);
    for (const v of values) l.add(v);
  }
  /** An admin deleting options in HubSpot. */
  remove(portalId: number, objectTypeId: string, prop: string, values: string[]): void {
    const l = this.list(portalId, objectTypeId, prop);
    for (const v of values) l.delete(v);
  }
  has(portalId: number, objectTypeId: string, prop: string, value: string): boolean {
    return this.list(portalId, objectTypeId, prop).has(value);
  }
  /** `prop=value` for every dropdown value in `properties` that is not an option. */
  invalid(portalId: number, objectTypeId: string, properties: Record<string, string>): string[] {
    const out: string[] = [];
    for (const prop of SYNCED_ENUM_PROPERTY_NAMES) {
      const raw = properties[prop];
      if (raw === undefined) continue;
      const values = LABEL_PROPERTY_NAMES.includes(prop) ? splitValues(raw) : [raw];
      for (const v of values) if (!this.has(portalId, objectTypeId, prop, v)) out.push(`${prop}=${v}`);
    }
    return out;
  }
}

/** HubSpot's per-record error for a value that is not an option (see stamp-queue.ts isInvalidOptionRefusal). */
export function invalidOptionError(id: string, bad: string): BatchError {
  const [name, value] = bad.split('=');
  const detail = JSON.stringify([{ isValid: false, message: `${value} was not one of the allowed options`, error: 'INVALID_OPTION', name }]);
  return { status: '400', category: 'VALIDATION_ERROR', message: `Property values were not valid: ${detail}`, context: { ids: [id] } };
}

/**
 * The option sync with only the HTTP faked: the real desired options (core/label-options.ts desiredSyncedOptions) added
 * to `options`; a failed label read is a labelError, exactly as the real sync reports it.
 */
export function fakeOptionSync(fetch: LabelFetcher, options: FakeOptions, before?: (portalId: number, objectTypeId: string) => void): SyncLabelOptions {
  return async (auth, objectTypeId, pairs) => {
    before?.(auth.portalId, objectTypeId);
    const others = otherTypesFor(objectTypeId, pairs);
    const report: LabelSyncReport = { portalId: auth.portalId, objectTypeId, otherObjectTypeIds: others, options: [], properties: [], labelErrors: [] };
    const sources: LabelSource[] = [];
    for (const other of others) {
      try {
        const defs = await fetch(auth.portalId, objectTypeId, other);
        sources.push({ otherObjectTypeId: other, otherObjectName: other, labels: defs.map((d) => ({ typeId: d.associationTypeId, label: d.label, category: d.category })) });
      } catch (e) {
        report.labelErrors.push({ from: objectTypeId, to: other, error: (e as Error).message });
      }
    }
    const desired = desiredSyncedOptions(others, sources, {});
    report.options = desired[STAMP_PROPS.labelsCurrent];
    for (const prop of SYNCED_ENUM_PROPERTY_NAMES) options.add(auth.portalId, objectTypeId, prop, desired[prop].map((x) => x.value));
    report.properties = SYNCED_ENUM_PROPERTY_NAMES.map((name) => ({ name, status: 'exists' as const, added: [] }));
    return report;
  };
}
