// Helpers for src/load-test.ts: a client-side rate limiter, HubSpot association + deal helpers (service key),
// a READ-ONLY view of the worker's SQLite DB, and small stats/table utilities.
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
import { DatabaseSync } from 'node:sqlite';
import { hsRequest, type RequestOpts } from '@changecatch/service/lib/http.js';

export const V = '2026-09';
export const DEAL = '0-3';
export const CONTACT = '0-1';

export type Label = { category: string; typeId: number; label: string | null };
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

// ------------------------------------------------------------------ rate limiter

/**
 * Sliding window: at most `max` requests per `windowMs`. The service key shares the portal's limit with the
 * installed app (110 / 10 s for marketplace apps), so we stay at 80 / 10 s and leave room for the worker.
 * Note: http.ts retries 429/5xx internally; those retries are not counted here.
 */
export class RateLimiter {
  private stamps: number[] = [];
  peak = 0;
  constructor(readonly max = 80, readonly windowMs = 10_000) {}

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.stamps.length && now - this.stamps[0] >= this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.max) {
        this.stamps.push(now);
        this.peak = Math.max(this.peak, this.stamps.length);
        return;
      }
      await sleep(this.windowMs - (now - this.stamps[0]) + 5);
    }
  }
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

  constructor(private readonly token: string, readonly rl: RateLimiter, readonly budget: OpBudget) {}

  async req<T = any>(path: string, opts: Omit<RequestOpts, 'token'> = {}): Promise<T> {
    await this.rl.take();
    this.calls++;
    this.times.push(Date.now());
    return hsRequest<T>(path, { ...opts, token: this.token });
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

  async labels(): Promise<Label[]> {
    return (await this.req<{ results: Label[] }>(`/crm/associations/${V}/${DEAL}/${CONTACT}/labels`)).results;
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
   * deal -> (contact -> label names on that link; null labels dropped). Follows per-deal paging.
   * Deals with no associations come back as errors in a 207, so a missing deal = empty map.
   */
  /** deal -> contact -> label keys (deal -> contact type ids of the labeled association types). */
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
            // Label KEYS (type id strings) of the labeled types, the same form the stamp pipeline uses (label-options.ts).
            const keys = t.associationTypes.filter((a) => !!a.label && a.label.trim() !== '').map((a) => String(a.typeId));
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

export interface ChangeRow {
  change_id: string;
  object_type_id: string;
  object_id: string;
  change_type: string;
  other_record_id: string;
  label_before: string;
  label_after: string;
  labels_current: string;
  occurred_at: string;
  created_at: number;
}

export class WorkerDb {
  readonly db: DatabaseSync;
  constructor(readonly path: string, readonly portalId: number) {
    if (!existsSync(path)) throw new Error(`${path} not found. Set DB_PATH to the worker's DB (relative paths resolve against service/).`);
    this.db = new DatabaseSync(path, { readOnly: true });
  }

  private inList(n: number) {
    return Array.from({ length: n }, () => '?').join(',');
  }

  private supersededCol: boolean | undefined;
  /** change_log.superseded_by exists (worker DB migration 7). Older worker DBs have no late-split corrections. */
  private hasSuperseded(): boolean {
    if (this.supersededCol === undefined) {
      const cols = this.db.prepare('PRAGMA table_info(change_log)').all() as { name: string }[];
      this.supersededCol = cols.some((c) => c.name === 'superseded_by');
    }
    return this.supersededCol;
  }

  private allRows(pairs: Pair[], sinceMs: number): (ChangeRow & { superseded_by: string | null })[] {
    const deals = [...new Set(pairs.map((p) => p.dealId))];
    if (!deals.length) return [];
    const want = new Set(pairs.map(pairKey));
    const sup = this.hasSuperseded() ? 'superseded_by' : 'NULL AS superseded_by';
    const rows = this.db
      .prepare(
        `SELECT change_id, object_type_id, object_id, change_type, other_record_id, label_before, label_after, labels_current, occurred_at, created_at, ${sup}
         FROM change_log WHERE portal_id = ? AND object_type_id = ? AND created_at >= ? AND object_id IN (${this.inList(deals.length)})`,
      )
      .all(this.portalId, DEAL, sinceMs, ...deals) as unknown as (ChangeRow & { superseded_by: string | null })[];
    return rows.filter((r) => want.has(`${r.object_id}|${r.other_record_id}`));
  }

  /**
   * change_log rows stamped on these deals since `sinceMs` (worker clock), filtered to our (deal, contact) pairs.
   * Rows SUPERSEDED by a late-split correction (already stamped, then corrected by a new change) are left out: they
   * are counted separately by supersededCount() and are neither extra nor wrong.
   */
  rows(pairs: Pair[], sinceMs: number): ChangeRow[] {
    return this.allRows(pairs, sinceMs)
      .filter((r) => r.superseded_by === null)
      .map(({ superseded_by: _s, ...r }) => r);
  }

  /** Late-split corrections: rows already stamped, then superseded by a new change (change_log.superseded_by). */
  supersededCount(pairs: Pair[], sinceMs: number): number {
    return this.allRows(pairs, sinceMs).filter((r) => r.superseded_by !== null).length;
  }

  /** Rows on the CONTACT side for our pairs (only if a Contact->Deal subscription or mirroring is active). Info only. */
  contactSideRows(pairs: Pair[], sinceMs: number): number {
    const contacts = [...new Set(pairs.map((p) => p.contactId))];
    if (!contacts.length) return 0;
    const want = new Set(pairs.map((p) => `${p.contactId}|${p.dealId}`));
    const rows = this.db
      .prepare(
        `SELECT object_id, other_record_id FROM change_log WHERE portal_id = ? AND object_type_id = ? AND created_at >= ? AND object_id IN (${this.inList(contacts.length)})`,
      )
      .all(this.portalId, CONTACT, sinceMs, ...contacts) as { object_id: string; other_record_id: string }[];
    return rows.filter((r) => want.has(`${r.object_id}|${r.other_record_id}`)).length;
  }

  /** Stamps still waiting in the worker's queue for these deals. */
  queued(dealIds: string[]): number {
    if (!dealIds.length) return 0;
    const keys = dealIds.map((d) => `${this.portalId}|${DEAL}|${d}`);
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM stamp_queue WHERE record_key IN (${this.inList(keys.length)})`).get(...keys) as { n: number };
    return Number(r.n);
  }

  /** change_id -> when the worker marked it stamped (seen_events "stamp:<id>", worker clock). */
  stampMarks(changeIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    const q = this.db.prepare('SELECT seen_at FROM seen_events WHERE key = ?');
    for (const id of changeIds) {
      const r = q.get('stamp:' + id) as { seen_at: number } | undefined;
      if (r) out.set(id, Number(r.seen_at));
    }
    return out;
  }

  journalOffset(): string | null {
    const r = this.db.prepare('SELECT offset FROM journal_offset WHERE id = 1').get() as { offset: string } | undefined;
    return r?.offset ?? null;
  }

  queuedTotal(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM stamp_queue').get() as { n: number }).n);
  }

  lastSuccessfulRead(): string | null {
    const r = this.db.prepare("SELECT value FROM worker_state WHERE key = 'last_successful_read_at'").get() as { value: string } | undefined;
    return r?.value ?? null;
  }

  watchedPairs(): string[] {
    const r = this.db.prepare('SELECT object_type_id, associated_object_type_id FROM portal_settings WHERE portal_id = ?').all(this.portalId) as {
      object_type_id: string;
      associated_object_type_id: string;
    }[];
    return r.map((x) => `${x.object_type_id}:${x.associated_object_type_id}`);
  }

  /** Per-portal stamp spacing from the settings page, if the portals table exists. */
  spacingSeconds(): number | null {
    try {
      const r = this.db.prepare('SELECT stamp_spacing_seconds AS s FROM portals WHERE portal_id = ?').get(this.portalId) as { s: number } | undefined;
      return r ? Number(r.s) : null;
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------------------ stats + table

/** Nearest-rank percentile (same as service/src/worker/latency.ts). */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

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

// ------------------------------------------------------------------ KPI inputs: worker /health, DB size, HTTP retries

/** GET the worker's /health JSON (200 or 503). null if not reachable. Shape is read defensively. */
export async function readHealth(port: number): Promise<Record<string, any> | null> {
  try {
    const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3_000) });
    return (await r.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

/** Resident memory of the worker, if /health exposes it under a known name. Otherwise null (skip). */
export function healthRss(h: Record<string, any> | null): number | null {
  const v = h?.memory?.rssBytes ?? h?.memory?.rss ?? h?.process?.rssBytes ?? h?.process?.rss ?? h?.rssBytes ?? h?.rss;
  return typeof v === 'number' ? v : null;
}

/** Worker HubSpot-call stats, if /health exposes them (limiter / http counters). Otherwise null (estimated instead). */
export function healthHttp(h: Record<string, any> | null): { peakPer10s?: number; status429?: number; status5xx?: number; retries?: number } | null {
  const l = h?.rateLimiter ?? h?.limiter ?? h?.http ?? null;
  if (!l || typeof l !== 'object') return null;
  const n = (x: unknown) => (typeof x === 'number' ? x : undefined);
  return { peakPer10s: n(l.peakPer10s ?? l.peak), status429: n(l.status429 ?? l.count429 ?? l['429']), status5xx: n(l.status5xx ?? l.count5xx), retries: n(l.retries) };
}

/** Sum of stamps_dropped over portals in a /health snapshot (stamps given up on = lost). */
export function healthDropped(h: Record<string, any> | null, portalId: number): number | null {
  const p = (h?.portals as any[] | undefined)?.find((x) => Number(x.portalId) === portalId);
  return typeof p?.stampsDropped === 'number' ? p.stampsDropped : null;
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

/** Counts http.ts retry warnings ("[http] ... -> 429, retry", "-> 503", "network error") in THIS process. */
export const httpCounters = { status429: 0, status5xx: 0, network: 0, retries: 0 };
export function installHttpCounter(): void {
  const orig = console.warn.bind(console);
  console.warn = (...a: unknown[]) => {
    const m = String(a[0] ?? '');
    if (m.startsWith('[http]')) {
      httpCounters.retries++;
      if (/-> 429/.test(m)) httpCounters.status429++;
      else if (/-> 5\d\d/.test(m)) httpCounters.status5xx++;
      else if (/network error/.test(m)) httpCounters.network++;
    }
    orig(...a);
  };
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
export function latest<T extends { occurred_at: string; created_at: number }>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.created_at - b.created_at).at(-1);
}

/** Samples the worker DB every second during a run: journal read cycles (distinct last_successful_read_at values). */
export class Sampler {
  readonly reads = new Set<string>();
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
