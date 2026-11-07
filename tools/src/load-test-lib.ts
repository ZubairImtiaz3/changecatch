// Helpers for src/load-test.ts and src/e2e-check.ts: the client-side rate limit (the service's RateLimiter),
// HubSpot association + deal helpers (service key), a READ-ONLY view of the worker's SQLite DB, the worker's /health,
// and small stats/table utilities.
//
// Endpoints (docs checked 2026-10-30, index https://developers.hubspot.com/docs/_llms/apis/2026-09/crm.txt):
//   POST /crm/associations/2026-09/0-3/0-1/batch/create          {inputs:[{from:{id},to:{id},types:[{associationCategory,associationTypeId}]}]}
//        Adds the given types. On an existing link it ADDS labels (does not replace them; verified against live HubSpot).
//        https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/batch/create-associations-labeled.md
//   POST /crm/associations/2026-09/0-3/0-1/batch/labels/archive  same body; removes only those labels
//        https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/batch/delete-association-labels.md
//   POST /crm/associations/2026-09/0-3/0-1/batch/archive         {inputs:[{from:{id},to:[{id}]}]}  max 100 unique "from"
//        https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/batch/delete-associations.md
//   POST /crm/associations/2026-09/0-3/0-1/batch/read            {inputs:[{id, after?}]}; per-"from" paging only when more pages exist
//        https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/batch/get-associations.md
//   GET  /crm/associations/2026-09/0-3/0-1/labels
//   GET  /crm/objects/2026-09/{type}?limit&after                  (list existing record ids)
//   GET  /crm/objects/2026-09/0-3/{id}/associations/0-1?limit=500&after
//   POST /crm/objects/2026-09/0-3/batch/read                      {inputs:[{id}], properties, propertiesWithHistory}
//        https://developers.hubspot.com/docs/api-reference/latest/crm/objects/deals/batch/get-deals.md
//        (we send 50 ids per call: the documented cap when propertiesWithHistory is used)

import { existsSync, statSync } from 'node:fs';
import { listLabelsRaw, type RawLabel } from '@changecatch/service/hubspot/labels.js';
import type { Config } from '@changecatch/service/lib/config.js';
import { HUBSPOT_API_VERSION as V, hsRequest, type RequestOpts } from '@changecatch/service/lib/http.js';
import { startProcess } from '@changecatch/service/lib/process.js';
import { createLogger } from '@changecatch/service/obs/log.js';
import { percentile } from '@changecatch/service/obs/metrics.js';
import { HEALTH_TOKEN_HEADER, type HealthSnapshot } from '@changecatch/service/worker/health.js';
import { recordKey } from '@changecatch/service/core/keys.js';
import type { LoggedChange } from '@changecatch/service/store/change-log.js';
import { Store } from '@changecatch/service/store/db.js';
import { PortalStore } from '@changecatch/service/store/portals.js';
import { portalPairs } from '@changecatch/service/core/pairs.js';
import { typeIdKey } from '@changecatch/service/core/label-options.js';
import type { Keyring } from '@changecatch/service/lib/crypto.js';

export { V };
export const DEAL = '0-3';
export const CONTACT = '0-1';

export type Label = RawLabel;
export type Pair = { dealId: string; contactId: string };
export const pairKey = (p: { dealId: string; contactId: string }) => `${p.dealId}|${p.contactId}`;

// ------------------------------------------------------------------ abort + sleep

/** Set by the SIGINT handler. Abortable waits throw, so scenario `finally` blocks (cleanup) run. */
export const abortState = { aborted: false };
export class AbortedError extends Error {}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sleep that throws AbortedError once Ctrl+C was pressed. Never use it inside cleanup. */
export async function waitSleep(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (abortState.aborted) throw new AbortedError('aborted by Ctrl+C');
    await sleep(Math.min(500, end - Date.now()));
  }
  if (abortState.aborted) throw new AbortedError('aborted by Ctrl+C');
}

export const iso = (ms: number) => new Date(ms).toISOString();

// ------------------------------------------------------------------ rate limit

/**
 * HubSpot counts burst limits per app (checked 2026-11-07,
 * https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines): the public app gets 110 / 10 s
 * per installed account, and a private app's 10 s limit "applies individually per app" (100 / 10 s on Free and
 * Starter, 190 on Professional and Enterprise). The page does not name service keys; we treat the service key like a
 * private app, so its calls do NOT use the worker's 110. 80 / 10 s stays under the lowest private-app tier.
 * The few calls the tools make with the portal's OAuth token DO share the app's 110 with the worker.
 * Daily limits (private apps: shared by all apps in the account) are far above a test run.
 */
export const TOOL_RATE_PER_10S = 80;

/**
 * Process setup for a tool (lib/process.ts startProcess) with the portal bucket of the service's sliding-window
 * limiter at TOOL_RATE_PER_10S. Every call made with the portal's portalId (service key and the portal's OAuth
 * token) shares that bucket.
 */
export function startTool(config: Config): void {
  startProcess({ ...config, portalRatePer10s: TOOL_RATE_PER_10S }, { log: createLogger('tools') });
}

// ------------------------------------------------------------------ HubSpot client (service key)

interface BatchResp {
  status?: string;
  results?: unknown[];
  numErrors?: number;
  errors?: { message?: string; category?: string }[];
}

export interface OpBudget {
  /** Association operations executed so far (one per input item), across all scenarios in this run. */
  used: number;
  max: number;
}

export class Hs {
  calls = 0;
  /** Local time of every request this script sent (for the per-portal pressure KPI). */
  readonly times: number[] = [];
  readonly errors: string[] = [];

  constructor(private readonly token: string, private readonly portalId: number, readonly budget: OpBudget) {}

  /** In the portal's rate bucket (TOOL_RATE_PER_10S). `times` gets the time each call ended; http.ts retries are not counted. */
  async req<T = any>(path: string, opts: Omit<RequestOpts, 'token' | 'portalId'> = {}): Promise<T> {
    this.calls++;
    try {
      return await hsRequest<T>(path, { ...opts, token: this.token, portalId: this.portalId });
    } finally {
      this.times.push(Date.now());
    }
  }

  /** Reserve `n` association operations. Cleanup passes force=true: it is never blocked by the cap. */
  private spend(n: number, force = false) {
    if (!force && this.budget.used + n > this.budget.max)
      throw new Error(`association-operation cap reached (${this.budget.used} + ${n} > ${this.budget.max}); raise --max-ops`);
    this.budget.used += n;
  }

  private note(what: string, r: BatchResp) {
    if (r?.numErrors) {
      const msg = `${what}: ${r.numErrors} error(s): ${(r.errors ?? []).slice(0, 3).map((e) => e.message ?? e.category).join(' | ')}`;
      this.errors.push(msg);
      console.warn(`  [hubspot] ${msg}`);
    }
  }

  // --- reads

  /** Deal->Contact label definitions (the service's labels call, in the portal's bucket). */
  async labels(): Promise<Label[]> {
    this.calls++;
    this.times.push(Date.now());
    return (await listLabelsRaw({ portalId: this.portalId, token: this.token }, DEAL, CONTACT)).results;
  }

  async listIds(type: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    let after: string | undefined;
    while (ids.length < limit) {
      const r = await this.req<{ results: { id: string }[]; paging?: { next?: { after: string } } }>(`/crm/objects/${V}/${type}`, {
        query: { limit: Math.min(100, limit - ids.length), after },
      });
      ids.push(...r.results.map((x) => x.id));
      after = r.paging?.next?.after;
      if (!after) break;
    }
    return ids;
  }

  /** Every contact linked to one deal (follows paging). */
  async linkedContactsAll(dealId: string): Promise<Set<string>> {
    const out = new Set<string>();
    let after: string | undefined;
    do {
      const r = await this.req<{ results: { toObjectId: number | string }[]; paging?: { next?: { after: string } } }>(
        `/crm/objects/${V}/${DEAL}/${dealId}/associations/${CONTACT}`,
        { query: { limit: 500, after } },
      );
      for (const x of r.results) out.add(String(x.toObjectId));
      after = r.paging?.next?.after;
    } while (after);
    return out;
  }

  /**
   * deal -> (contact -> label keys on that link): the type ids (as strings) of the LABELED association types, the
   * same form the stamp pipeline uses (label-options.ts); the unlabeled type is dropped. Follows per-deal paging.
   * Deals with no associations come back as errors in a 207, so a missing deal = empty map.
   */
  async linksOf(dealIds: string[]): Promise<Map<string, Map<string, string[]>>> {
    const out = new Map<string, Map<string, string[]>>(dealIds.map((d) => [d, new Map()]));
    type Res = {
      from: { id: string };
      to: { toObjectId: number | string; associationTypes: { category: string; typeId: number; label: string | null }[] }[];
      paging?: { next?: { after?: string } };
    };
    let todo: { id: string; after?: string }[] = dealIds.map((id) => ({ id }));
    while (todo.length) {
      const next: { id: string; after?: string }[] = [];
      for (let i = 0; i < todo.length; i += 100) {
        const r = await this.req<{ results?: Res[] }>(`/crm/associations/${V}/${DEAL}/${CONTACT}/batch/read`, {
          method: 'POST',
          body: { inputs: todo.slice(i, i + 100) },
        });
        for (const res of r.results ?? []) {
          const m = out.get(String(res.from.id)) ?? new Map<string, string[]>();
          out.set(String(res.from.id), m);
          for (const t of res.to) {
            const keys = t.associationTypes.filter((a) => !!a.label && a.label.trim() !== '').map((a) => typeIdKey(a.typeId));
            m.set(String(t.toObjectId), [...new Set([...(m.get(String(t.toObjectId)) ?? []), ...keys])]);
          }
          const a = res.paging?.next?.after;
          if (a) next.push({ id: String(res.from.id), after: a });
        }
      }
      todo = next;
    }
    return out;
  }

  /** Deals with current properties + history (50 per call). */
  async dealsWithHistory(dealIds: string[], props: string[], historyProps: string[]): Promise<Map<string, DealSnapshot>> {
    const out = new Map<string, DealSnapshot>();
    for (let i = 0; i < dealIds.length; i += 50) {
      const r = await this.req<{
        results: { id: string; properties: Record<string, string | null>; propertiesWithHistory?: Record<string, { value: string; timestamp: string }[]> }[];
      }>(`/crm/objects/${V}/${DEAL}/batch/read`, {
        method: 'POST',
        body: { inputs: dealIds.slice(i, i + 50).map((id) => ({ id })), properties: props, propertiesWithHistory: historyProps },
      });
      for (const x of r.results ?? []) out.set(String(x.id), { properties: x.properties ?? {}, history: x.propertiesWithHistory ?? {} });
    }
    return out;
  }

  // --- association writes (each input item = 1 association operation)

  async addTypes(pairs: Pair[], types: Label[], what: string): Promise<void> {
    for (let i = 0; i < pairs.length; i += 100) {
      const chunk = pairs.slice(i, i + 100);
      this.spend(chunk.length);
      const r = await this.req<BatchResp>(`/crm/associations/${V}/${DEAL}/${CONTACT}/batch/create`, {
        method: 'POST',
        body: { inputs: chunk.map((p) => ({ from: { id: p.dealId }, to: { id: p.contactId }, types: types.map(spec) })) },
      });
      this.note(what, r);
    }
  }

  async archiveLabels(pairs: Pair[], types: Label[], what: string): Promise<void> {
    for (let i = 0; i < pairs.length; i += 100) {
      const chunk = pairs.slice(i, i + 100);
      this.spend(chunk.length);
      const r = await this.req<BatchResp>(`/crm/associations/${V}/${DEAL}/${CONTACT}/batch/labels/archive`, {
        method: 'POST',
        body: { inputs: chunk.map((p) => ({ from: { id: p.dealId }, to: { id: p.contactId }, types: types.map(spec) })) },
      });
      this.note(what, r);
    }
  }

  /** Removes whole links. Max 100 unique "from" per call, so grouped by deal. force=true for cleanup. */
  async unlink(pairs: Pair[], what: string, force = false): Promise<void> {
    const byDeal = new Map<string, string[]>();
    for (const p of pairs) byDeal.set(p.dealId, [...(byDeal.get(p.dealId) ?? []), p.contactId]);
    const inputs = [...byDeal.entries()].map(([d, cs]) => ({ from: { id: d }, to: cs.map((id) => ({ id })) }));
    for (let i = 0; i < inputs.length; i += 100) {
      const chunk = inputs.slice(i, i + 100);
      this.spend(chunk.reduce((n, x) => n + x.to.length, 0), force);
      const r = await this.req<BatchResp>(`/crm/associations/${V}/${DEAL}/${CONTACT}/batch/archive`, { method: 'POST', body: { inputs: chunk } });
      this.note(what, r);
    }
  }
}

const spec = (l: Label) => ({ associationCategory: l.category, associationTypeId: l.typeId });

export interface DealSnapshot {
  properties: Record<string, string | null>;
  /** Newest first (HubSpot order). */
  history: Record<string, { value: string; timestamp: string }[]>;
}

// ------------------------------------------------------------------ worker DB (READ-ONLY)

/** One change_log row (the service's Store type). */
export type ChangeRow = LoggedChange;

/** READ-ONLY view of the worker's DB through the service's Store (no migrations, no timers, no copied SQL or keys). */
export class WorkerDb {
  readonly store: Store;
  /** Install state + watched pairs, on the same read-only connection (the only path to portal_settings). */
  private readonly portals: PortalStore;
  constructor(readonly path: string, readonly portalId: number, key: Keyring) {
    if (!existsSync(path)) throw new Error(`${path} not found. Set DB_PATH to the worker's DB (relative paths resolve against service/).`);
    this.store = new Store(path, { readOnly: true });
    this.portals = new PortalStore({ db: this.store.conn, key });
  }

  private allRows(pairs: Pair[], sinceMs: number): ChangeRow[] {
    const want = new Set(pairs.map(pairKey));
    return this.store
      .changes.changesForRecords(this.portalId, DEAL, [...new Set(pairs.map((p) => p.dealId))], sinceMs)
      .filter((r) => want.has(`${r.objectId}|${r.otherRecordId}`));
  }

  /**
   * change_log rows stamped on these deals since `sinceMs` (worker clock), filtered to our (deal, contact) pairs.
   * Rows SUPERSEDED by a late-split correction (already stamped, then corrected by a new change) are left out: they
   * are counted separately by supersededCount() and are neither extra nor wrong.
   */
  rows(pairs: Pair[], sinceMs: number): ChangeRow[] {
    return this.allRows(pairs, sinceMs).filter((r) => r.supersededBy === null);
  }

  /** Late-split corrections: rows already stamped, then superseded by a new change (change_log.superseded_by). */
  supersededCount(pairs: Pair[], sinceMs: number): number {
    return this.allRows(pairs, sinceMs).filter((r) => r.supersededBy !== null).length;
  }

  /** Rows on the CONTACT side for our pairs (only if a Contact->Deal subscription or mirroring is active). Info only. */
  contactSideRows(pairs: Pair[], sinceMs: number): number {
    const want = new Set(pairs.map((p) => `${p.contactId}|${p.dealId}`));
    return this.store
      .changes.changesForRecords(this.portalId, CONTACT, [...new Set(pairs.map((p) => p.contactId))], sinceMs)
      .filter((r) => want.has(`${r.objectId}|${r.otherRecordId}`)).length;
  }

  /** Stamps still waiting in the worker's queue for these deals. */
  queued(dealIds: string[]): number {
    return this.store.stamps.queuedCountFor(dealIds.map((d) => recordKey({ portalId: this.portalId, objectTypeId: DEAL, objectId: d })));
  }

  /** change_id -> when the worker marked its stamp handled (worker clock). */
  stampMarks(changeIds: string[]): Map<string, number> {
    return this.store.seen.stampHandledAt(changeIds);
  }

  journalOffset(): string | null {
    return this.store.journal.getOffset();
  }

  queuedTotal(): number {
    return this.store.stamps.queueSize();
  }

  /** Epoch ms of the worker's last successful journal read. */
  lastSuccessfulRead(): number | null {
    return this.store.journal.getLastSuccessfulReadAt();
  }

  /** The pairs the worker processes (core/pairs.ts portalPairs(...).active, the rule buildWorker uses). */
  watchedPairs(): string[] {
    return portalPairs(this.portals, this.portalId).active.map((x) => `${x.objectTypeId}:${x.associatedObjectTypeId}`);
  }

  /** Does the worker process the a <-> b pair (either orientation)? */
  watches(a: string, b: string): boolean {
    const w = this.watchedPairs();
    return w.includes(`${a}:${b}`) || w.includes(`${b}:${a}`);
  }

  /** Per-portal stamp spacing from the settings page. null = portal not installed. */
  spacingSeconds(): number | null {
    return this.portals.getPortal(this.portalId)?.stampSpacingSeconds ?? null;
  }
}

// ------------------------------------------------------------------ stats + table

export interface LatencyStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export function latencyStats(ms: number[]): LatencyStats {
  const s = [...ms].sort((a, b) => a - b);
  return { count: s.length, p50Ms: percentile(s, 50), p95Ms: percentile(s, 95), p99Ms: percentile(s, 99), maxMs: s.length ? s[s.length - 1] : null };
}

/** Most events inside any sliding window of `windowMs`. */
export function windowPeak(times: number[], windowMs: number): number {
  const t = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < t.length; i++) {
    while (t[i] - t[j] >= windowMs) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

// ------------------------------------------------------------------ KPI inputs: worker /health, DB size

/**
 * GET the worker's /health (200 or 503). null if not reachable. Sends HEALTH_TOKEN_HEADER when HEALTH_TOKEN is set, so
 * the per-portal detail is included.
 */
export async function readHealth(worker: { healthPort: number; healthToken: string | undefined }): Promise<HealthSnapshot | null> {
  const { healthPort: port, healthToken: token } = worker;
  try {
    const r = await fetch(`http://localhost:${port}/health`, {
      headers: token ? { [HEALTH_TOKEN_HEADER]: token } : {},
      signal: AbortSignal.timeout(3_000),
    });
    return (await r.json()) as HealthSnapshot;
  } catch {
    return null;
  }
}

/** DB + WAL + SHM size in bytes. */
export function dbFileSize(path: string): number {
  let n = 0;
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      n += statSync(f).size;
    } catch {
      /* missing is fine */
    }
  }
  return n;
}

export const secs = (ms: number | null | undefined) => (ms === null || ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);

export interface Check {
  scenario: string;
  check: string;
  /** null = info only (never fails the run). */
  pass: boolean | null;
  detail: string;
}

export function printTable(checks: Check[]): boolean {
  const ws = Math.max(8, ...checks.map((c) => c.scenario.length));
  const wc = Math.max(5, ...checks.map((c) => c.check.length));
  console.log(`\n${'SCENARIO'.padEnd(ws)}  ${'CHECK'.padEnd(wc)}  RESULT  DETAIL`);
  for (const c of checks)
    console.log(`${c.scenario.padEnd(ws)}  ${c.check.padEnd(wc)}  ${(c.pass === null ? 'info' : c.pass ? 'PASS' : 'FAIL').padEnd(6)}  ${c.detail}`);
  const pass = checks.some((c) => c.pass !== null) && checks.every((c) => c.pass !== false);
  console.log(`\nOVERALL: ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

/** Latest row (by occurredAt, then created_at). */
export function latest<T extends { occurredAt: string; createdAt: number }>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.createdAt - b.createdAt).at(-1);
}

/** Samples the worker DB every second during a run: journal read cycles (distinct last_successful_read_at values). */
export class Sampler {
  readonly reads = new Set<number>();
  readonly offsets = new Set<string>();
  maxQueue = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly db: WorkerDb) {}
  start(): void {
    const first = this.db.lastSuccessfulRead();
    const firstOff = this.db.journalOffset();
    this.timer = setInterval(() => {
      try {
        const r = this.db.lastSuccessfulRead();
        if (r && r !== first) this.reads.add(r);
        const o = this.db.journalOffset();
        if (o && o !== firstOff) this.offsets.add(o);
        this.maxQueue = Math.max(this.maxQueue, this.db.queuedTotal());
      } catch {
        /* DB busy: skip this tick */
      }
    }, 1_000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
