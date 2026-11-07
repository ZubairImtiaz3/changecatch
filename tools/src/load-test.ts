// ChangeCatch load test: real association changes in a TEST portal, then check what the RUNNING worker did.
// It does NOT start the worker. Start the service first (`pnpm --filter @changecatch/service dev`), same DB_PATH.
// Helpers + endpoint doc links: load-test-lib.ts
//
// Usage (from tools/):
//   pnpm exec tsx src/load-test.ts <scenario> --portal <portalId> [--deal <dealId>]         -> dry run: picks free pairs (read-only), prints the plan
//   pnpm exec tsx src/load-test.ts <scenario> --portal <portalId> [--deal <dealId>] --yes   -> runs it
//   scenarios: burst-one-record | spread-many-records | label-churn | mixed (= burst + spread at the same time)
//   required:  --portal <id> (or HUBSPOT_TEST_PORTAL_ID); --deal <id> (the burst deal) for burst-one-record and mixed
//   options:   --n 100 (links per burst/spread)  --relabel 20 (burst links that get a label change)
//              --links 10 --flips 5 --flip-gap 1 (s, label-churn)
//              --gap 10 (s between phases)  --timeout 1800 (s per drain wait)  --settle 15 (s quiet before "drained")
//              --max-ops 500 (hard cap on association operations per run)
//              --labels "A,B,C" (three Deal->Contact label names; type IDs are looked up by name; see lib/test-labels.ts)
//              --append-kpis (append the KPI row to docs/kpis.md)   --kpi-p50 10 --kpi-p95 20 --kpi-correct 100 --kpi-wrong 0 --kpi-peak 100
//
// Safety: creates/deletes NO records. Only links (deal, contact) pairs that are NOT linked today (checked first), so
// every link it touches is fresh. Every created link is removed in `finally` (also on Ctrl+C), then re-checked.
// Requests go through the portal bucket of the service limiter at 80 req / 10 s (TOOL_RATE_PER_10S in
// load-test-lib.ts says why). One "association operation" = one input item in a batch call (create, label add, label archive, unlink).
// Auth: HUBSPOT_SETUP_TOKEN service key (never printed). The worker DB is opened READ-ONLY.

import { writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NONE, STAMP_PROPS, UNKNOWN } from '@changecatch/service/core/contract.js';
import { loadConfig, REPO_ROOT } from '@changecatch/service/lib/config.js';
import { formatLabelValues, labelOptionValue, splitValues } from '@changecatch/service/core/label-options.js';
import type { HealthSnapshot } from '@changecatch/service/worker/health.js';
import {
  AbortedError,
  CONTACT,
  DEAL,
  Hs,
  Sampler,
  TOOL_RATE_PER_10S,
  WorkerDb,
  abortState,
  dbFileSize,
  startTool,
  readHealth,
  windowPeak,
  iso,
  latencyStats,
  latest,
  pairKey,
  printTable,
  secs,
  waitSleep,
  type ChangeRow,
  type Check,
  type DealSnapshot,
  type Label,
  type Pair,
} from './load-test-lib.js';
import { flag, num, parseArgs, portalIdFrom, setupTokenOf, str } from './lib/cli.js';
import { samplePath } from './lib/paths.js';
import { labelByName, testLabelNames } from './lib/test-labels.js';

// ------------------------------------------------------------------ args

const parsed = parseArgs(process.argv.slice(2), ['yes', 'append-kpis']);

const SCENARIOS = ['burst-one-record', 'spread-many-records', 'label-churn', 'mixed'] as const;
type ScenarioName = (typeof SCENARIOS)[number];
const scenarioArg = parsed._.find((a) => (SCENARIOS as readonly string[]).includes(a)) as ScenarioName | undefined;

const yes = flag(parsed, 'yes');
const N = Math.floor(num(parsed, 'n') ?? 100);
const RELABEL = Math.floor(num(parsed, 'relabel') ?? 20);
const BURST_DEAL = str(parsed, 'deal');
const LINKS = Math.floor(num(parsed, 'links') ?? 10);
const FLIPS = Math.floor(num(parsed, 'flips') ?? 5);
const FLIP_GAP_MS = (num(parsed, 'flip-gap') ?? 1) * 1000;
const GAP_MS = (num(parsed, 'gap') ?? 10) * 1000;
const TIMEOUT_MS = (num(parsed, 'timeout') ?? 1800) * 1000;
const SETTLE_MS = (num(parsed, 'settle') ?? 15) * 1000;
const MAX_OPS = Math.floor(num(parsed, 'max-ops') ?? 500);
const config = loadConfig('tool');
const DB_PATH = config.dbPath;
const POLL_MS = 2_000;
/** Set at the start of main() from --portal / HUBSPOT_TEST_PORTAL_ID (no default). */
let PORTAL_ID = 0;

const APPEND_KPIS = flag(parsed, 'append-kpis');
const KPI_DOC = join(REPO_ROOT, 'docs', 'kpis.md');
/** KPI targets (owner, 2026-10-30). WARN band: latency up to 2x target; peak up to the 110/10 s portal limit. */
const T = {
  p50Ms: (num(parsed, 'kpi-p50') ?? 10) * 1000,
  p95Ms: (num(parsed, 'kpi-p95') ?? 20) * 1000,
  correctPct: num(parsed, 'kpi-correct') ?? 100,
  wrongMax: Math.max(0, num(parsed, 'kpi-wrong') ?? 0),
  peakPer10s: num(parsed, 'kpi-peak') ?? 100,
  portalLimitPer10s: 110,
};

const PROPS = Object.values(STAMP_PROPS);
const HISTORY_PROPS = [STAMP_PROPS.changeId, STAMP_PROPS.labelsCurrent];

// ------------------------------------------------------------------ context

interface Labels {
  structural: Label;
  inf: Label;
  dm: Label;
  bc: Label;
}

interface Ctx {
  hs: Hs;
  db: WorkerDb;
  labels: Labels;
  checks: Check[];
  out: Record<string, unknown>;
  kpis: ScenarioKpi[];
}

/** Option value for a deal -> contact label: keyed by its type id (label-options.ts). */
const optVal = (l: Label) => labelOptionValue(CONTACT, l.typeId);

function check(ctx: Ctx, scenario: string, name: string, pass: boolean | null, detail: string) {
  const c: Check = { scenario, check: name, pass, detail };
  ctx.checks.push(c);
  console.log(`  [${scenario}] ${pass === null ? 'info' : pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

// ------------------------------------------------------------------ picking free pairs (read-only)

class Pool {
  private usedContacts = new Set<string>();
  private usedDeals = new Set<string>();
  private dealCursor = 0;
  constructor(readonly contacts: string[], readonly deals: string[]) {}

  reserveDeal(id: string) {
    this.usedDeals.add(id);
  }

  takeDeals(n: number): string[] {
    const out: string[] = [];
    while (out.length < n && this.dealCursor < this.deals.length) {
      const d = this.deals[this.dealCursor++];
      if (this.usedDeals.has(d)) continue;
      this.usedDeals.add(d);
      out.push(d);
    }
    if (out.length < n) throw new Error(`Only ${out.length} free deals left in the pool (wanted ${n}).`);
    return out;
  }

  /** A contact not used by any scenario in this run and not linked to the deal today. */
  takeContact(linked: { has(id: string): boolean }): string | undefined {
    const c = this.contacts.find((id) => !this.usedContacts.has(id) && !linked.has(id));
    if (c) this.usedContacts.add(c);
    return c;
  }
}

async function pickOneDeal(hs: Hs, pool: Pool, dealId: string, n: number): Promise<Pair[]> {
  const linked = await hs.linkedContactsAll(dealId);
  const pairs: Pair[] = [];
  for (let i = 0; i < n; i++) {
    const c = pool.takeContact(linked);
    if (!c) throw new Error(`Only ${pairs.length} free contacts for deal ${dealId} (wanted ${n}).`);
    pairs.push({ dealId, contactId: c });
  }
  return pairs;
}

async function pickManyDeals(hs: Hs, pool: Pool, n: number): Promise<Pair[]> {
  const deals = pool.takeDeals(n);
  const links = await hs.linksOf(deals);
  return deals.map((d) => {
    const c = pool.takeContact(links.get(d) ?? new Map());
    if (!c) throw new Error(`No free contact left for deal ${d}.`);
    return { dealId: d, contactId: c };
  });
}

// ------------------------------------------------------------------ waiting + analysis

interface Drain {
  rows: ChangeRow[];
  /** From the end of the last action until all expected rows were logged and the queue was empty. */
  drainMs: number | null;
  timedOut: boolean;
}

/**
 * Polls the worker DB until `isDone(rows)` holds, no stamp is queued for these deals, and nothing changed for
 * --settle seconds. Abortable (Ctrl+C).
 */
async function waitDrain(ctx: Ctx, scenario: string, pairs: Pair[], sinceMs: number, tActEnd: number, isDone: (rows: ChangeRow[]) => { done: boolean; detail: string }): Promise<Drain> {
  const deals = [...new Set(pairs.map((p) => p.dealId))];
  let doneSince: number | null = null;
  let countAt = -1;
  let lastLog = 0;
  let rows: ChangeRow[] = [];
  while (Date.now() - tActEnd < TIMEOUT_MS) {
    rows = ctx.db.rows(pairs, sinceMs);
    const q = ctx.db.queued(deals);
    const d = isDone(rows);
    const now = Date.now();
    if (d.done && q === 0) {
      if (doneSince === null || rows.length !== countAt) {
        doneSince = now;
        countAt = rows.length;
      } else if (now - doneSince >= SETTLE_MS) {
        noteCorrections(ctx, scenario, pairs, sinceMs);
        return { rows, drainMs: doneSince - tActEnd, timedOut: false };
      }
    } else {
      doneSince = null;
    }
    if (now - lastLog >= 15_000) {
      lastLog = now;
      console.log(`  [${scenario}] +${secs(now - tActEnd)}: ${rows.length} change_log rows, ${q} stamps queued; ${d.detail}`);
    }
    await waitSleep(POLL_MS);
  }
  noteCorrections(ctx, scenario, pairs, sinceMs);
  return { rows, drainMs: null, timedOut: true };
}

/** Late-split corrections (superseded rows) for the scenario's KPI: INFO only, never extra / wrong. */
function noteCorrections(ctx: Ctx, scenario: string, pairs: Pair[], sinceMs: number): void {
  const k = ctx.kpis.find((x) => x.scenario === scenario);
  if (k) k.corrections = Math.max(k.corrections, ctx.db.supersededCount(pairs, sinceMs));
}

/** Did every pair get a row of each type? */
function coverage(rows: ChangeRow[], pairs: Pair[], type: string): number {
  const have = new Set(rows.filter((r) => r.changeType === type).map((r) => `${r.objectId}|${r.otherRecordId}`));
  return pairs.filter((p) => have.has(pairKey(p))).length;
}

interface StampInfo {
  stampsInHistory: number;
  stampsMarkedInDb: number;
  latency: ReturnType<typeof latencyStats>;
  latencySource: string;
  firstStampAt: number | null;
  lastStampAt: number | null;
  timings: RowTiming[];
}

/** One change_log row with its timings (for the KPI scorecard). */
interface RowTiming {
  scenario: string;
  changeId: string;
  type: string;
  dealId: string;
  /** occurredAt -> written to change_log (worker clock vs HubSpot clock; small skew possible). */
  loggedMs: number;
  loggedAt: number;
  /** occurredAt -> stamped (property history timestamp = HubSpot clock; DB stamp mark as fallback). null = not stamped. */
  stampedMs: number | null;
  /** Local (worker) time the stamp was accepted, from the DB mark; history time as fallback. */
  stampAtLocal: number | null;
}

/** occurredAt -> stamped, from the deals' changecatch_last_change_id history (HubSpot clock); DB mark as fallback. */
function stampInfo(ctx: Ctx, scenario: string, rows: ChangeRow[], snaps: Map<string, DealSnapshot>): StampInfo {
  const byId = new Map(rows.map((r) => [r.changeId, r]));
  const hist = new Map<string, number>();
  for (const s of snaps.values())
    for (const h of s.history[STAMP_PROPS.changeId] ?? []) if (byId.has(h.value) && !hist.has(h.value)) hist.set(h.value, Date.parse(h.timestamp));
  const marks = ctx.db.stampMarks([...byId.keys()]);
  const lat: number[] = [];
  const timings: RowTiming[] = [];
  let fromDb = 0;
  for (const r of rows) {
    const occurred = Date.parse(r.occurredAt);
    const at = hist.get(r.changeId) ?? marks.get(r.changeId);
    const ok = at !== undefined && Number.isFinite(occurred);
    if (ok) {
      if (!hist.has(r.changeId)) fromDb++;
      lat.push(at - occurred);
    }
    timings.push({
      scenario,
      changeId: r.changeId,
      type: r.changeType,
      dealId: r.objectId,
      loggedMs: Number(r.createdAt) - occurred,
      loggedAt: Number(r.createdAt),
      stampedMs: ok ? at - occurred : null,
      stampAtLocal: marks.get(r.changeId) ?? hist.get(r.changeId) ?? null,
    });
  }
  const times = [...hist.values()].sort((a, b) => a - b);
  return {
    stampsInHistory: hist.size,
    stampsMarkedInDb: marks.size,
    latency: latencyStats(lat),
    latencySource: fromDb ? `property history (+${fromDb} from DB stamp marks)` : 'property history',
    firstStampAt: times[0] ?? null,
    lastStampAt: times.at(-1) ?? null,
    timings,
  };
}

/** Per-scenario KPI inputs, filled by each scenario and turned into the scorecard by main(). */
interface ScenarioKpi {
  scenario: string;
  ops: number;
  /** Logical changes we caused (one per link add / relabel / flip / unlink). */
  expected: number;
  /** Of those, how many have a change_log row. */
  logged: number;
  rows: number;
  timings: RowTiming[];
  /** Deals whose stamped labels_current was compared with HubSpot's real labels. */
  finalTotal: number;
  finalOk: number;
  finalExamples: string[];
  /** Deals whose final stamp is not their last change. */
  missed: number;
  missedExamples: string[];
  wrong: number;
  wrongExamples: string[];
  lastOpAt: number | null;
  stampsInHistory: number;
  /** Late-split corrections: rows already stamped, then superseded by a new change (not in `rows`, not extra/wrong). */
  corrections: number;
}

const newKpi = (scenario: string, ops: number, expected: number): ScenarioKpi => ({
  scenario, ops, expected, logged: 0, rows: 0, timings: [], finalTotal: 0, finalOk: 0, finalExamples: [], missed: 0, missedExamples: [],
  wrong: 0, wrongExamples: [], lastOpAt: null, stampsInHistory: 0, corrections: 0,
});

/** Stamped labels_current vs HubSpot's real labels for the pair in each deal's final stamp (after the run's last action). */
async function finalLabelMatch(ctx: Ctx, dealIds: string[], snaps: Map<string, DealSnapshot>): Promise<{ total: number; ok: number; examples: string[] }> {
  const links = await ctx.hs.linksOf(dealIds);
  let ok = 0;
  const examples: string[] = [];
  for (const d of dealIds) {
    const p = snaps.get(d)?.properties ?? {};
    const other = p[STAMP_PROPS.otherRecordId] ?? '';
    const want = formatLabelValues(links.get(d)?.get(other) ?? [], CONTACT);
    if (p[STAMP_PROPS.labelsCurrent] === want) ok++;
    else if (examples.length < 3) examples.push(`${d}: stamp "${p[STAMP_PROPS.labelsCurrent]}" vs HubSpot "${want}"`);
  }
  return { total: dealIds.length, ok, examples };
}

const latLine = (s: StampInfo) =>
  `p50 ${secs(s.latency.p50Ms)}, p95 ${secs(s.latency.p95Ms)}, max ${secs(s.latency.maxMs)} over ${s.latency.count} stamps (${s.latencySource})`;

/** The deal's current stamp must be (one of) the newest change_log row(s) for that deal. */
function finalStampOk(rows: ChangeRow[], dealId: string, snap: DealSnapshot | undefined): { ok: boolean; detail: string } {
  const mine = rows.filter((r) => r.objectId === dealId);
  const last = latest(mine);
  if (!last) return { ok: false, detail: 'no rows' };
  const maxAt = Date.parse(last.occurredAt);
  const newest = new Set(mine.filter((r) => Date.parse(r.occurredAt) === maxAt).map((r) => r.changeId));
  const cur = snap?.properties[STAMP_PROPS.changeId] ?? null;
  const ok = !!cur && newest.has(cur);
  return { ok, detail: `stamp ${cur ?? '(none)'} ${snap?.properties[STAMP_PROPS.changeType] ?? ''}; newest row(s) ${[...newest].slice(0, 2).join(',')} ${last.changeType}` };
}

// ------------------------------------------------------------------ cleanup (always runs)

async function cleanup(ctx: Ctx, scenario: string, created: Pair[]): Promise<void> {
  if (!created.length) return;
  const deals = [...new Set(created.map((p) => p.dealId))];
  try {
    const links = await ctx.hs.linksOf(deals);
    const left = created.filter((p) => links.get(p.dealId)?.has(p.contactId));
    if (left.length) {
      console.log(`  [${scenario}] cleanup: removing ${left.length} link(s) this run created`);
      await ctx.hs.unlink(left, `${scenario} cleanup`, true);
    }
    const after = await ctx.hs.linksOf(deals);
    const still = created.filter((p) => after.get(p.dealId)?.has(p.contactId));
    ctx.out[`${scenario}:leftover`] = still;
    check(ctx, scenario, 'cleanup', still.length === 0, still.length ? `${still.length} links still exist (see JSON "${scenario}:leftover")` : `0 of ${created.length} links left`);
  } catch (e) {
    ctx.out[`${scenario}:leftover`] = created;
    check(ctx, scenario, 'cleanup', false, `FAILED (${(e as Error).message}). All pairs are in the JSON; remove them by hand.`);
  }
}

// ------------------------------------------------------------------ scenarios

interface Scenario {
  name: string;
  ops: number;
  plan: string[];
  run(ctx: Ctx): Promise<void>;
}

function burstScenario(pairs: Pair[]): Scenario {
  const name = 'burst-one-record';
  const dealId = pairs[0].dealId;
  const rel = pairs.slice(0, Math.min(RELABEL, pairs.length));
  return {
    name,
    ops: pairs.length * 2 + rel.length * 2,
    plan: [
      `${name}: deal ${dealId}, ${pairs.length} free contacts`,
      `  1 batch link ${pairs.length} contacts with label 1                       ${pairs.length} ops`,
      `  2 (+${GAP_MS / 1000}s) relabel ${rel.length}: add label 2, archive label 1          ${rel.length * 2} ops`,
      `  3 (+${GAP_MS / 1000}s) unlink all ${pairs.length}                                         ${pairs.length} ops`,
      `  expect: ${pairs.length} ADDED + ${rel.length} LABEL_CHANGED + ${pairs.length} REMOVED rows; final stamp = newest row`,
    ],
    async run(ctx) {
      const { hs, labels: L } = ctx;
      const t0 = Date.now();
      const since = t0 - 5_000;
      const created: Pair[] = [];
      const res: Record<string, unknown> = { dealId, pairs, relabeled: rel, startedAt: iso(t0) };
      ctx.out[name] = res;
      const kpi = newKpi(name, pairs.length * 2 + rel.length * 2, pairs.length * 2 + rel.length);
      ctx.kpis.push(kpi);
      try {
        created.push(...pairs); // before the call: a failed call may still have linked some
        await hs.addTypes(pairs, [L.structural, L.inf], `${name} link`);
        await waitSleep(GAP_MS);
        await hs.addTypes(rel, [L.dm], `${name} relabel add`);
        await hs.archiveLabels(rel, [L.inf], `${name} relabel archive`);
        await waitSleep(GAP_MS);
        await hs.unlink(pairs, `${name} unlink`);
        const tEnd = Date.now();
        kpi.lastOpAt = tEnd;
        res.actionsEndedAt = iso(tEnd);

        const d = await waitDrain(ctx, name, pairs, since, tEnd, (rows) => {
          const a = coverage(rows, pairs, 'ADDED');
          const l = coverage(rows, rel, 'LABEL_CHANGED');
          const r = coverage(rows, pairs, 'REMOVED');
          return { done: a === pairs.length && l === rel.length && r === pairs.length, detail: `ADDED ${a}/${pairs.length}, LABEL_CHANGED ${l}/${rel.length}, REMOVED ${r}/${pairs.length}` };
        });
        const rows = d.rows;
        const a = coverage(rows, pairs, 'ADDED');
        const l = coverage(rows, rel, 'LABEL_CHANGED');
        const r = coverage(rows, pairs, 'REMOVED');
        check(ctx, name, 'every change in change_log', a === pairs.length && l === rel.length && r === pairs.length,
          `ADDED ${a}/${pairs.length}, LABEL_CHANGED ${l}/${rel.length}, REMOVED ${r}/${pairs.length} (${rows.length} rows total)`);
        check(ctx, name, 'drained', !d.timedOut, d.timedOut ? `timeout ${TIMEOUT_MS / 1000}s` : `time to drain ${secs(d.drainMs)} after the last action`);

        const INF = optVal(L.inf);
        const DM = optVal(L.dm);
        const lcOk = rel.filter((p) =>
          rows.some((x) => x.changeType === 'LABEL_CHANGED' && x.otherRecordId === p.contactId && splitValues(x.labelBefore).includes(INF) && splitValues(x.labelAfter).includes(DM)),
        ).length;
        check(ctx, name, `label changes read "${L.inf.label} -> ${L.dm.label}"`, lcOk === rel.length, `${lcOk}/${rel.length}`);

        const snaps = await hs.dealsWithHistory([dealId], PROPS, HISTORY_PROPS);
        const fin = finalStampOk(rows, dealId, snaps.get(dealId));
        check(ctx, name, 'deal stamp = the LAST change', fin.ok, fin.detail);

        const s = stampInfo(ctx, name, rows, snaps);
        const fl = await finalLabelMatch(ctx, [dealId], snaps);
        Object.assign(kpi, {
          logged: a + l + r, rows: rows.length, timings: s.timings, stampsInHistory: s.stampsInHistory,
          finalTotal: fl.total, finalOk: fl.ok, finalExamples: fl.examples,
          missed: fin.ok ? 0 : 1, missedExamples: fin.ok ? [] : [`${dealId}: ${fin.detail}`],
          wrong: rel.length - lcOk, wrongExamples: lcOk < rel.length ? [`${rel.length - lcOk} label changes not read as ${L.inf.label} -> ${L.dm.label}`] : [],
        });
        check(ctx, name, 'stamps written', null, `${s.stampsInHistory} in property history, ${s.stampsMarkedInDb} marked in DB, for ${rows.length} changes (coalescing would lower this)`);
        check(ctx, name, 'latency occurredAt->stamped', null, latLine(s));
        const cs = ctx.db.contactSideRows(pairs, since);
        if (cs) check(ctx, name, 'contact-side rows', null, `${cs} (a Contact->Deal subscription or mirroring is on)`);
        Object.assign(res, { drainMs: d.drainMs, timedOut: d.timedOut, rows, stamps: s, finalDeal: snaps.get(dealId) });
      } catch (e) {
        if (!(e instanceof AbortedError)) check(ctx, name, 'run', false, (e as Error).message);
        else check(ctx, name, 'run', false, 'aborted');
      } finally {
        await cleanup(ctx, name, created);
      }
    },
  };
}

function spreadScenario(pairs: Pair[]): Scenario {
  const name = 'spread-many-records';
  return {
    name,
    ops: pairs.length * 2,
    plan: [
      `${name}: ${pairs.length} different deals, 1 free contact each`,
      `  1 batch link each pair with a label (labels 1 / 2 / 3 in turn)                       ${pairs.length} ops`,
      `  2 (+${GAP_MS / 1000}s) unlink all                                                            ${pairs.length} ops`,
      `  expect: ${pairs.length} ADDED (right label) + ${pairs.length} REMOVED; every deal stamped; final stamp = REMOVED`,
    ],
    async run(ctx) {
      const { hs, labels: L } = ctx;
      const cycle = [L.inf, L.dm, L.bc];
      const labelOf = new Map(pairs.map((p, i) => [pairKey(p), cycle[i % 3]]));
      const t0 = Date.now();
      const since = t0 - 5_000;
      const created: Pair[] = [];
      const res: Record<string, unknown> = { pairs: pairs.map((p) => ({ ...p, label: labelOf.get(pairKey(p))!.label })), startedAt: iso(t0) };
      ctx.out[name] = res;
      const kpi = newKpi(name, pairs.length * 2, pairs.length * 2);
      ctx.kpis.push(kpi);
      try {
        created.push(...pairs);
        for (const lab of cycle) await hs.addTypes(pairs.filter((p) => labelOf.get(pairKey(p)) === lab), [L.structural, lab], `${name} link ${lab.label}`);
        const tLinked = Date.now();
        await waitSleep(GAP_MS);
        await hs.unlink(pairs, `${name} unlink`);
        const tEnd = Date.now();
        kpi.lastOpAt = tEnd;
        Object.assign(res, { linkedAt: iso(tLinked), actionsEndedAt: iso(tEnd) });

        const d = await waitDrain(ctx, name, pairs, since, tEnd, (rows) => {
          const a = coverage(rows, pairs, 'ADDED');
          const r = coverage(rows, pairs, 'REMOVED');
          return { done: a === pairs.length && r === pairs.length, detail: `ADDED ${a}/${pairs.length}, REMOVED ${r}/${pairs.length}` };
        });
        const rows = d.rows;
        const a = coverage(rows, pairs, 'ADDED');
        const r = coverage(rows, pairs, 'REMOVED');
        check(ctx, name, 'every change in change_log', a === pairs.length && r === pairs.length, `ADDED ${a}/${pairs.length}, REMOVED ${r}/${pairs.length} (${rows.length} rows total)`);
        check(ctx, name, 'drained', !d.timedOut, d.timedOut ? `timeout ${TIMEOUT_MS / 1000}s` : `time to drain ${secs(d.drainMs)} after the last action`);

        const labelOk = pairs.filter((p) => {
          const want = optVal(labelOf.get(pairKey(p))!);
          return rows.some((x) => x.changeType === 'ADDED' && x.objectId === p.dealId && x.otherRecordId === p.contactId && splitValues(x.labelAfter).includes(want));
        }).length;
        check(ctx, name, 'ADDED rows carry the right label', labelOk === pairs.length, `${labelOk}/${pairs.length}`);

        const deals = pairs.map((p) => p.dealId);
        const snaps = await hs.dealsWithHistory(deals, PROPS, HISTORY_PROPS);
        const runIds = new Set(rows.map((x) => x.changeId));
        let stamped = 0;
        let finalOk = 0;
        const bad: string[] = [];
        for (const dId of deals) {
          const snap = snaps.get(dId);
          if ((snap?.history[STAMP_PROPS.changeId] ?? []).some((h) => runIds.has(h.value))) stamped++;
          const f = finalStampOk(rows, dId, snap);
          if (f.ok) finalOk++;
          else if (bad.length < 3) bad.push(`${dId}: ${f.detail}`);
        }
        check(ctx, name, 'every deal stamped', stamped === deals.length, `${stamped}/${deals.length} deals have a stamp from this run`);
        check(ctx, name, 'each deal stamp = its LAST change', finalOk === deals.length, `${finalOk}/${deals.length}${bad.length ? `; e.g. ${bad.join(' | ')}` : ''}`);

        const s = stampInfo(ctx, name, rows, snaps);
        const fl = await finalLabelMatch(ctx, deals, snaps);
        Object.assign(kpi, {
          logged: a + r, rows: rows.length, timings: s.timings, stampsInHistory: s.stampsInHistory,
          finalTotal: fl.total, finalOk: fl.ok, finalExamples: fl.examples,
          missed: deals.length - finalOk, missedExamples: bad,
          wrong: pairs.length - labelOk, wrongExamples: labelOk < pairs.length ? [`${pairs.length - labelOk} ADDED rows without the label we set`] : [],
        });
        const span =s.firstStampAt !== null && s.lastStampAt !== null ? s.lastStampAt - s.firstStampAt : null;
        check(ctx, name, 'throughput', null,
          `${rows.length} changes drained in ${secs(d.drainMs)} after the last action; ${s.stampsInHistory} stamps over ${secs(span)}` +
            (span ? ` (${((s.stampsInHistory / span) * 60_000).toFixed(0)} stamps/min)` : ''));
        check(ctx, name, 'latency occurredAt->stamped', null, latLine(s));
        const cs = ctx.db.contactSideRows(pairs, since);
        if (cs) check(ctx, name, 'contact-side rows', null, `${cs} (a Contact->Deal subscription or mirroring is on)`);
        Object.assign(res, { drainMs: d.drainMs, timedOut: d.timedOut, rows, stamps: s });
      } catch (e) {
        check(ctx, name, 'run', false, e instanceof AbortedError ? 'aborted' : (e as Error).message);
      } finally {
        await cleanup(ctx, name, created);
      }
    },
  };
}

function churnScenario(pairs: Pair[]): Scenario {
  const name = 'label-churn';
  return {
    name,
    ops: pairs.length * 2 + pairs.length * FLIPS * 2,
    plan: [
      `${name}: ${pairs.length} fresh links (different deals), ${FLIPS} label flips each, ~${FLIP_GAP_MS / 1000}s apart`,
      `  1 batch link with label 1                                                     ${pairs.length} ops`,
      `  2 (+${GAP_MS / 1000}s) ${FLIPS} flips: add next label, archive previous (label 1 -> 2 -> 3 -> 1 ...)   ${pairs.length * FLIPS * 2} ops`,
      `  3 wait until drained; compare each deal's labels_current with HubSpot's real labels; scan for wrong labels`,
      `  4 unlink all                                                                  ${pairs.length} ops`,
    ],
    async run(ctx) {
      const { hs, labels: L } = ctx;
      const cycle = [L.inf, L.dm, L.bc];
      const allowed = new Set(cycle.map(optVal));
      const finalLabel = cycle[FLIPS % 3];
      const expectedFinal = formatLabelValues([String(finalLabel.typeId)], CONTACT);
      const deals = pairs.map((p) => p.dealId);
      const t0 = Date.now();
      const since = t0 - 5_000;
      const created: Pair[] = [];
      const res: Record<string, unknown> = { pairs, flips: FLIPS, expectedFinal, startedAt: iso(t0) };
      ctx.out[name] = res;
      const kpi = newKpi(name, pairs.length * 2 + pairs.length * FLIPS * 2, pairs.length * (2 + FLIPS));
      ctx.kpis.push(kpi);
      try {
        created.push(...pairs);
        await hs.addTypes(pairs, [L.structural, L.inf], `${name} link`);
        await waitSleep(GAP_MS);
        for (let f = 1; f <= FLIPS; f++) {
          await hs.addTypes(pairs, [cycle[f % 3]], `${name} flip ${f} add`);
          await hs.archiveLabels(pairs, [cycle[(f - 1) % 3]], `${name} flip ${f} archive`);
          if (f < FLIPS) await waitSleep(FLIP_GAP_MS);
        }
        const tFlips = Date.now();
        res.flipsEndedAt = iso(tFlips);

        const d = await waitDrain(ctx, name, pairs, since, tFlips, (rows) => {
          const ok = pairs.filter((p) => latest(rows.filter((x) => x.objectId === p.dealId))?.labelsCurrent === expectedFinal).length;
          return { done: ok === pairs.length, detail: `${ok}/${pairs.length} deals' newest row = ${expectedFinal}` };
        });
        const rows = d.rows;
        check(ctx, name, 'drained', !d.timedOut, d.timedOut ? `timeout ${TIMEOUT_MS / 1000}s` : `time to drain ${secs(d.drainMs)} after the last flip`);

        // HubSpot's real current labels (source of truth), read BEFORE cleanup.
        const links = await hs.linksOf(deals);
        const actual = new Map(pairs.map((p) => [p.dealId, formatLabelValues(links.get(p.dealId)?.get(p.contactId) ?? [], CONTACT)]));
        res.actualLabels = Object.fromEntries(actual);
        const hsAsPlanned = pairs.filter((p) => actual.get(p.dealId) === expectedFinal).length;
        check(ctx, name, 'HubSpot ended on the planned label', hsAsPlanned === pairs.length, `${hsAsPlanned}/${pairs.length} = ${expectedFinal}`);

        const snaps = await hs.dealsWithHistory(deals, PROPS, HISTORY_PROPS);
        const mism: string[] = [];
        let stampOk = 0;
        let rowOk = 0;
        for (const p of pairs) {
          const want = actual.get(p.dealId)!;
          const got = snaps.get(p.dealId)?.properties[STAMP_PROPS.labelsCurrent] ?? null;
          if (got === want) stampOk++;
          else if (mism.length < 3) mism.push(`${p.dealId}: stamp "${got}" vs HubSpot "${want}"`);
          if (latest(rows.filter((x) => x.objectId === p.dealId))?.labelsCurrent === want) rowOk++;
        }
        check(ctx, name, 'deal labels_current = HubSpot labels', stampOk === pairs.length, `${stampOk}/${pairs.length}${mism.length ? `; ${mism.join(' | ')}` : ''}`);
        check(ctx, name, 'newest change_log row = HubSpot labels', rowOk === pairs.length, `${rowOk}/${pairs.length}`);

        // Wrong labels: anything outside the 3 labels we used, or "(unknown)". "(none)" is only expected on
        // label_before of ADDED rows; elsewhere it is counted as transient (info).
        const wrong: string[] = [];
        let transientNone = 0;
        const scan = (where: string, v: string, noneOk: boolean) => {
          for (const x of splitValues(v)) {
            if (x === NONE) {
              if (!noneOk) transientNone++;
            } else if (x === UNKNOWN || !allowed.has(x)) wrong.push(`${where}: ${x}`);
          }
        };
        for (const x of rows) {
          scan(`${x.changeId} label_before`, x.labelBefore, x.changeType === 'ADDED');
          scan(`${x.changeId} label_after`, x.labelAfter, x.changeType === 'REMOVED');
          scan(`${x.changeId} labels_current`, x.labelsCurrent, x.changeType === 'REMOVED');
        }
        for (const [dId, s] of snaps)
          for (const h of s.history[STAMP_PROPS.labelsCurrent] ?? []) if (Date.parse(h.timestamp) >= t0) scan(`deal ${dId} history`, h.value, false);
        check(ctx, name, 'no wrong labels (change_log + labels_current history)', wrong.length === 0, wrong.length ? `${wrong.length}: ${wrong.slice(0, 3).join(' | ')}` : 'none');
        if (transientNone) check(ctx, name, 'transient "(none)" values', null, `${transientNone} (a link that always had a label showed none for a moment)`);

        const types = rows.reduce<Record<string, number>>((m, x) => ((m[x.changeType] = (m[x.changeType] ?? 0) + 1), m), {});
        const s = stampInfo(ctx, name, rows, snaps);
        // Expected: 1 ADDED + FLIPS LABEL_CHANGED per link (+ 1 REMOVED, added after the unlink below).
        const lcPerPair = (p: Pair) => rows.filter((x) => x.changeType === 'LABEL_CHANGED' && x.objectId === p.dealId && x.otherRecordId === p.contactId).length;
        Object.assign(kpi, {
          logged: coverage(rows, pairs, 'ADDED') + pairs.reduce((n, p) => n + Math.min(FLIPS, lcPerPair(p)), 0),
          rows: rows.length, timings: s.timings, stampsInHistory: s.stampsInHistory,
          finalTotal: pairs.length, finalOk: stampOk, finalExamples: mism,
          wrong: wrong.length, wrongExamples: wrong.slice(0, 5),
        });
        check(ctx, name, 'rows + stamps', null, `${rows.length} rows (${Object.entries(types).map(([k, v]) => `${k} ${v}`).join(', ')}) for ${pairs.length * FLIPS} flips; ${s.stampsInHistory} stamps in history`);
        check(ctx, name, 'latency occurredAt->stamped', null, latLine(s));
        Object.assign(res, { drainMs: d.drainMs, timedOut: d.timedOut, rows, stamps: s, wrong });

        // Unlink (also the cleanup) and check the REMOVED rows arrive.
        await hs.unlink(pairs, `${name} unlink`);
        const tEnd = Date.now();
        kpi.lastOpAt = tEnd;
        const d2 = await waitDrain(ctx, name, pairs, since, tEnd, (rs) => {
          const r = coverage(rs, pairs, 'REMOVED');
          return { done: r === pairs.length, detail: `REMOVED ${r}/${pairs.length}` };
        });
        const removed = coverage(d2.rows, pairs, 'REMOVED');
        check(ctx, name, 'unlink logged', !d2.timedOut, `REMOVED ${removed}/${pairs.length}, drained ${secs(d2.drainMs)}`);
        // Re-read with the REMOVED rows so latency/throughput include them.
        const snaps2 = await hs.dealsWithHistory(deals, PROPS, HISTORY_PROPS);
        const s2 = stampInfo(ctx, name, d2.rows, snaps2);
        const missedEx: string[] = [];
        let missed = 0;
        for (const dId of deals) {
          const f = finalStampOk(d2.rows, dId, snaps2.get(dId));
          if (!f.ok) {
            missed++;
            if (missedEx.length < 3) missedEx.push(`${dId}: ${f.detail}`);
          }
        }
        Object.assign(kpi, { logged: kpi.logged + removed, rows: d2.rows.length, timings: s2.timings, stampsInHistory: s2.stampsInHistory, missed, missedExamples: missedEx });
      } catch (e) {
        check(ctx, name, 'run', false, e instanceof AbortedError ? 'aborted' : (e as Error).message);
      } finally {
        await cleanup(ctx, name, created);
      }
    },
  };
}

// ------------------------------------------------------------------ KPI scorecard

type Grade = 'PASS' | 'WARN' | 'FAIL' | 'INFO';
interface KpiRow {
  area: string;
  kpi: string;
  value: string;
  target: string;
  grade: Grade;
}

interface RunEnv {
  scenario: string;
  hs: Hs;
  sampler: Sampler;
  healthBefore: HealthSnapshot | null;
  healthAfter: HealthSnapshot | null;
  dbBytesBefore: number;
  dbBytesAfter: number;
}

const pct = (a: number, b: number) => (b ? (a / b) * 100 : 100);
const fmtPct = (v: number) => `${v.toFixed(1)}%`;
const gradeLat = (v: number | null, target: number): Grade => (v === null ? 'FAIL' : v <= target ? 'PASS' : v <= target * 2 ? 'WARN' : 'FAIL');
const latStr = (s: ReturnType<typeof latencyStats>) => `p50 ${secs(s.p50Ms)} / p95 ${secs(s.p95Ms)} / p99 ${secs(s.p99Ms)} / max ${secs(s.maxMs)} (n=${s.count})`;
const mb = (b: number | null) => (b === null ? 'n/a' : `${(b / 1024 / 1024).toFixed(1)} MB`);
const healthLat = (h: HealthSnapshot | null) => {
  const l = h?.latency;
  return l ? `p50 ${secs(l.p50Ms)}, p95 ${secs(l.p95Ms)}, max ${secs(l.maxMs)}, n=${l.count}, total ${l.totalSamples}` : h ? 'not wired' : 'unreachable';
};
/** Change of a /health number over the run. null if either snapshot is missing. */
const delta = (f: (h: HealthSnapshot) => number | undefined, a: HealthSnapshot | null, b: HealthSnapshot | null) => {
  const x = a && f(a);
  const y = b && f(b);
  return typeof x === 'number' && typeof y === 'number' ? y - x : null;
};

/** Peak + sustained rate per second over a list of local timestamps. */
function rates(times: number[]): { sustained: number | null; peak10s: number; first: number | null; last: number | null } {
  const t = [...times].sort((a, b) => a - b);
  const span = t.length > 1 ? t[t.length - 1] - t[0] : 0;
  return { sustained: span > 0 ? t.length / (span / 1000) : null, peak10s: windowPeak(t, 10_000), first: t[0] ?? null, last: t.at(-1) ?? null };
}

function scorecard(kpis: ScenarioKpi[], e: RunEnv): { rows: KpiRow[]; verdict: Grade; summary: Record<string, unknown>; markdown: string } {
  const rows: KpiRow[] = [];
  const add = (area: string, kpi: string, value: string, target: string, grade: Grade) => rows.push({ area, kpi, value, target, grade });
  const all = kpis.flatMap((k) => k.timings);
  const sum = (f: (k: ScenarioKpi) => number) => kpis.reduce((n, k) => n + f(k), 0);

  // 1. Correctness
  const expected = sum((k) => k.expected);
  const logged = sum((k) => k.logged);
  const ops = sum((k) => k.ops);
  const loggedPct = pct(logged, expected);
  add('correctness', 'changes in change_log', `${logged}/${expected} = ${fmtPct(loggedPct)} (${ops} association ops, ${all.length} rows)`, `>= ${T.correctPct}%`, loggedPct >= T.correctPct ? 'PASS' : 'FAIL');
  const fTot = sum((k) => k.finalTotal);
  const fOk = sum((k) => k.finalOk);
  const finalPct = pct(fOk, fTot);
  const fEx = kpis.flatMap((k) => k.finalExamples).slice(0, 2);
  add('correctness', 'final labels_current = HubSpot', `${fOk}/${fTot} = ${fmtPct(finalPct)}${fEx.length ? `; ${fEx.join(' | ')}` : ''}`, `>= ${T.correctPct}%`, finalPct >= T.correctPct ? 'PASS' : 'FAIL');
  const wrong = sum((k) => k.wrong);
  const wEx = kpis.flatMap((k) => k.wrongExamples).slice(0, 2);
  add('correctness', 'wrong labels', `${wrong}${wEx.length ? `; ${wEx.join(' | ')}` : ''}`, `<= ${T.wrongMax}`, wrong <= T.wrongMax ? 'PASS' : 'FAIL');
  const missed = sum((k) => k.missed);
  const mEx = kpis.flatMap((k) => k.missedExamples).slice(0, 2);
  add('correctness', 'missed stamps (final stamp != last change)', `${missed}${mEx.length ? `; ${mEx.join(' | ')}` : ''}`, '0', missed === 0 ? 'PASS' : 'FAIL');
  const unstamped = all.filter((t) => t.stampedMs === null).length;
  add('correctness', 'rows never stamped (coalesced or lost)', String(unstamped), 'info', 'INFO');
  add(
    'correctness',
    'late-split corrections',
    `${sum((k) => k.corrections)} (stamped change superseded by a new, correct change; not counted as extra or wrong)`,
    'info',
    'INFO',
  );

  // 2. Latency
  const stampedAll = latencyStats(all.flatMap((t) => (t.stampedMs === null ? [] : [t.stampedMs])));
  const loggedAll = latencyStats(all.map((t) => t.loggedMs));
  add('latency', 'occurredAt -> stamped p50', secs(stampedAll.p50Ms), `<= ${secs(T.p50Ms)}`, gradeLat(stampedAll.p50Ms, T.p50Ms));
  add('latency', 'occurredAt -> stamped p95', secs(stampedAll.p95Ms), `<= ${secs(T.p95Ms)}`, gradeLat(stampedAll.p95Ms, T.p95Ms));
  add('latency', 'occurredAt -> stamped (all)', latStr(stampedAll), 'info', 'INFO');
  add('latency', 'occurredAt -> change_log (all)', latStr(loggedAll), 'info', 'INFO');
  for (const type of ['ADDED', 'LABEL_CHANGED', 'REMOVED']) {
    const ts = all.filter((t) => t.type === type);
    if (!ts.length) continue;
    add('latency', `${type}: -> change_log`, latStr(latencyStats(ts.map((t) => t.loggedMs))), 'info', 'INFO');
    add('latency', `${type}: -> stamped`, latStr(latencyStats(ts.flatMap((t) => (t.stampedMs === null ? [] : [t.stampedMs])))), 'info', 'INFO');
  }
  for (const k of kpis) {
    const s = latencyStats(k.timings.flatMap((t) => (t.stampedMs === null ? [] : [t.stampedMs])));
    add('latency', `${k.scenario}: -> stamped`, latStr(s), `p95 <= ${secs(T.p95Ms)}`, gradeLat(s.p95Ms, T.p95Ms));
  }
  add('latency', 'worker /health latency before', healthLat(e.healthBefore), 'info', 'INFO');
  add('latency', 'worker /health latency after', healthLat(e.healthAfter), 'info', 'INFO');

  // 3. Throughput
  const ing = rates(all.map((t) => t.loggedAt));
  const stm = rates(all.flatMap((t) => (t.stampAtLocal === null ? [] : [t.stampAtLocal])));
  add('throughput', 'changes ingested / s', `sustained ${ing.sustained?.toFixed(2) ?? 'n/a'}, peak ${(ing.peak10s / 10).toFixed(1)} (10 s window)`, 'info', 'INFO');
  add('throughput', 'stamps written / s', `sustained ${stm.sustained?.toFixed(2) ?? 'n/a'}, peak ${(stm.peak10s / 10).toFixed(1)} (10 s window)`, 'info', 'INFO');
  const drains: string[] = [];
  let worstDrain: number | null = null;
  for (const k of kpis) {
    const last = Math.max(...k.timings.map((t) => t.stampAtLocal ?? -Infinity));
    const dMs = k.lastOpAt !== null && Number.isFinite(last) ? last - k.lastOpAt : null;
    if (dMs !== null) worstDrain = Math.max(worstDrain ?? 0, dMs);
    drains.push(`${k.scenario} ${k.rows} changes: ${secs(dMs)}`);
  }
  add('throughput', 'time to drain (last op -> last stamp)', drains.join('; '), 'info', 'INFO');

  // 4. Per-portal pressure (script requests are exact; worker stamp calls are estimated from distinct stamp times)
  const stampBatchTimes = [...new Set(all.flatMap((t) => (t.stampAtLocal === null ? [] : [t.stampAtLocal])))];
  const scriptPeak = windowPeak(e.hs.times, 10_000);
  const combinedPeak = windowPeak([...e.hs.times, ...stampBatchTimes], 10_000);
  const peakGrade: Grade = combinedPeak <= T.peakPer10s ? 'PASS' : combinedPeak <= T.portalLimitPer10s ? 'WARN' : 'FAIL';
  add('pressure', 'peak requests / 10 s, portal ' + PORTAL_ID,
    `${combinedPeak} (script ${scriptPeak}, worker stamp batches estimated; label calls not counted); headroom ${T.portalLimitPer10s - combinedPeak} vs ${T.portalLimitPer10s}`,
    `<= ${T.peakPer10s}`, peakGrade);
  // Worker-wide counters (all portals), so other portals' traffic during the run shows up here too.
  const w429 = delta((h) => h?.httpErrors?.status429, e.healthBefore, e.healthAfter);
  const w5xx = delta((h) => h?.httpErrors?.status5xx, e.healthBefore, e.healthAfter);
  add('pressure', 'worker HubSpot 429 / 5xx during the run', w429 === null || w5xx === null ? '/health unreachable' : `${w429} / ${w5xx}`, '0 / 0',
    w429 === null || w5xx === null ? 'INFO' : w429 + w5xx === 0 ? 'PASS' : 'WARN');
  const dropped = delta((h) => h.totals.stampsDropped, e.healthBefore, e.healthAfter);
  const lossGrade: Grade = dropped === null ? (missed === 0 && unstamped === 0 ? 'PASS' : 'WARN') : dropped === 0 && missed === 0 ? 'PASS' : 'FAIL';
  add('pressure', 'no 5xx-induced loss (stamps dropped)', dropped === null ? `/health unreachable; missed ${missed}, unstamped ${unstamped}` : `${dropped} dropped during the run (all portals)`, '0', lossGrade);

  // 5. Efficiency
  const reads = e.sampler.reads.size;
  add('efficiency', 'worker HubSpot calls per change (est.)', all.length ? `${(stampBatchTimes.length / all.length).toFixed(3)} stamp batch calls/change (${stampBatchTimes.length} batches); label calls not visible` : 'n/a', 'info', 'INFO');
  add('efficiency', 'script HubSpot calls per change', all.length ? (e.hs.calls / all.length).toFixed(2) : 'n/a', 'info', 'INFO');
  add('efficiency', 'journal reads per 100 changes', all.length ? `${((reads / all.length) * 100).toFixed(1)} (${reads} read cycles, ${e.sampler.offsets.size} offset moves)` : 'n/a', 'info', 'INFO');
  const burst = kpis.find((k) => k.scenario === 'burst-one-record');
  const coalescing = burst && burst.stampsInHistory ? burst.rows / burst.stampsInHistory : null;
  if (burst) add('efficiency', 'coalescing ratio (burst record: changes / stamps)', coalescing === null ? 'n/a' : `${coalescing.toFixed(2)} (${burst.rows} / ${burst.stampsInHistory})`, 'info (1.0 = no coalescing)', 'INFO');

  // 6. Burst isolation (mixed only): spread stamps made while the burst record was still draining
  const spread = kpis.find((k) => k.scenario === 'spread-many-records');
  if (burst && spread) {
    const bt = burst.timings.flatMap((t) => (t.stampAtLocal === null ? [] : [t.stampAtLocal]));
    const [from, to] = [Math.min(...bt), Math.max(...bt)];
    const during = spread.timings.filter((t) => t.stampAtLocal !== null && t.stampAtLocal >= from && t.stampAtLocal <= to && t.stampedMs !== null);
    const s = latencyStats(during.map((t) => t.stampedMs!));
    add('isolation', 'spread latency while burst drains', bt.length ? latStr(s) : 'burst never stamped', `p95 <= ${secs(T.p95Ms)}`, during.length ? gradeLat(s.p95Ms, T.p95Ms) : 'INFO');
  }

  // 7. Resources
  add('resources', 'DB size before -> after', `${mb(e.dbBytesBefore)} -> ${mb(e.dbBytesAfter)} (+${((e.dbBytesAfter - e.dbBytesBefore) / 1024).toFixed(0)} KB)`, 'info', 'INFO');

  const graded = rows.filter((r) => r.grade !== 'INFO');
  const verdict: Grade = graded.some((r) => r.grade === 'FAIL') ? 'FAIL' : graded.some((r) => r.grade === 'WARN') ? 'WARN' : 'PASS';
  const summary = {
    scenario: e.scenario, changes: all.length, expected, logged, loggedPct, finalPct, wrong, missed, unstamped,
    stamped: stampedAll, logged_latency: loggedAll, worstDrainMs: worstDrain, peakPer10s: combinedPeak,
    workerHttpErrors: { status429: w429, status5xx: w5xx }, coalescing, verdict,
  };
  const markdown =
    `| ${new Date().toISOString().slice(0, 16).replace('T', ' ')} | ${e.scenario} | ${all.length} | ${fmtPct(loggedPct)} | ${fmtPct(finalPct)} | ${wrong} | ${missed} | ` +
    `${secs(stampedAll.p50Ms)} | ${secs(stampedAll.p95Ms)} | ${secs(stampedAll.p99Ms)} | ${secs(worstDrain)} | ${combinedPeak} | ${w429 ?? '-'}/${w5xx ?? '-'} | ` +
    `${coalescing === null ? '-' : coalescing.toFixed(2)} | ${verdict} |`;
  return { rows, verdict, summary, markdown };
}

const KPI_MD_HEADER =
  '| Date (UTC) | Scenario | Changes | Logged % | Final labels % | Wrong | Missed | Stamp p50 | p95 | p99 | Drain | Peak req/10s | 429/5xx | Coalescing | Verdict |\n' +
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';

function printScorecard(rows: KpiRow[], verdict: Grade) {
  const wa = Math.max(...rows.map((r) => r.area.length));
  const wk = Math.max(...rows.map((r) => r.kpi.length));
  const wt = Math.max(6, ...rows.map((r) => r.target.length));
  console.log(`\n== KPI SCORECARD`);
  console.log(`${'AREA'.padEnd(wa)}  ${'KPI'.padEnd(wk)}  GRADE  ${'TARGET'.padEnd(wt)}  VALUE`);
  for (const r of rows) console.log(`${r.area.padEnd(wa)}  ${r.kpi.padEnd(wk)}  ${r.grade.padEnd(5)}  ${r.target.padEnd(wt)}  ${r.value}`);
  console.log(`KPI VERDICT: ${verdict}`);
}

// ------------------------------------------------------------------ main

function usage() {
  console.log(`Usage: tsx src/load-test.ts <${SCENARIOS.join(' | ')}> --portal <portalId> [--deal <dealId>] [--yes] [options]  (see tools/README.md)`);
}

function save(out: Record<string, unknown>, scenario: string, kind: string) {
  out.endedAt = iso(Date.now());
  const file = samplePath(config.tools.samplesDir, `load-${scenario}-${kind}`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Saved: ${file}`);
}

async function main() {
  if (!scenarioArg) {
    usage();
    process.exitCode = 1;
    return;
  }
  const scenario = scenarioArg;
  PORTAL_ID = portalIdFrom(parsed, config.tools.testPortalId);
  const needsBurstDeal = scenario === 'burst-one-record' || scenario === 'mixed';
  if (needsBurstDeal && (!BURST_DEAL || !/^\d+$/.test(BURST_DEAL))) {
    console.error(`Scenario "${scenario}" needs --deal <dealId> (the deal that gets the burst). No default.`);
    process.exitCode = 1;
    return;
  }
  const labelNames = testLabelNames(parsed, 3, config.tools.testLabels);
  const serviceKey = setupTokenOf(config.tools);
  startTool(config);
  const budget = { used: 0, max: MAX_OPS };
  const hs = new Hs(serviceKey, PORTAL_ID, budget);
  const out: Record<string, unknown> = {
    startedAt: iso(Date.now()),
    scenario,
    portalId: PORTAL_ID,
    dbPath: DB_PATH,
    options: { N, RELABEL, BURST_DEAL, LINKS, FLIPS, FLIP_GAP_MS, GAP_MS, TIMEOUT_MS, SETTLE_MS, MAX_OPS },
  };

  // --- read-only pre-checks
  console.log(`\nChangeCatch load test "${scenario}", portal ${PORTAL_ID}${yes ? '' : ' (DRY RUN)'}`);
  let db: WorkerDb | null = null;
  const problems: string[] = [];
  try {
    db = new WorkerDb(DB_PATH, PORTAL_ID, config.tokenKey);
    const pairsW = db.watchedPairs();
    if (!db.watches(DEAL, CONTACT)) problems.push(`watched pair 0-3:0-1 missing in DB (have ${pairsW.join(', ') || 'none'})`);
    const lr = db.lastSuccessfulRead();
    const lrMs = lr ?? NaN;
    const age = Number.isFinite(lrMs) ? Date.now() - lrMs : Infinity;
    if (!(age < 10 * 60_000)) problems.push(`worker's last successful read is ${Number.isFinite(lrMs) ? iso(lrMs) : 'never'} (>10 min): is the worker running?`);
    const sp = db.spacingSeconds();
    console.log(`  DB ${DB_PATH}: watched ${pairsW.join(', ') || 'none'}; last read ${Number.isFinite(lrMs) ? iso(lrMs) : 'never'}; stamp spacing ${sp ?? 'default'} s`);
    out.stampSpacingSeconds = sp;
  } catch (e) {
    problems.push((e as Error).message);
  }

  const all = await hs.labels();
  const structural = all.find((x) => x.label === null && x.category === 'HUBSPOT_DEFINED');
  if (!structural) throw new Error('No unlabeled HUBSPOT_DEFINED Deal->Contact type in the labels endpoint.');
  const labels: Labels = { structural, inf: labelByName(all, labelNames[0]), dm: labelByName(all, labelNames[1]), bc: labelByName(all, labelNames[2]) };
  out.labels = labels;
  console.log(`  labels: 1 = "${labels.inf.label}" (${labels.inf.typeId}), 2 = "${labels.dm.label}" (${labels.dm.typeId}), 3 = "${labels.bc.label}" (${labels.bc.typeId})`);

  // --- pick free pairs (read-only)
  const wantBurst = scenario === 'burst-one-record' || scenario === 'mixed';
  const wantSpread = scenario === 'spread-many-records' || scenario === 'mixed';
  const wantChurn = scenario === 'label-churn';
  const contactsNeeded = (wantBurst ? N : 0) + (wantSpread ? N : 0) + (wantChurn ? LINKS : 0);
  const dealsNeeded = (wantSpread ? N : 0) + (wantChurn ? LINKS : 0);
  const pool = new Pool(await hs.listIds(CONTACT, contactsNeeded + 100), dealsNeeded ? await hs.listIds(DEAL, dealsNeeded + 20) : []);
  if (BURST_DEAL) pool.reserveDeal(BURST_DEAL);
  const scenarios: Scenario[] = [];
  if (wantBurst) scenarios.push(burstScenario(await pickOneDeal(hs, pool, BURST_DEAL!, N)));
  if (wantSpread) scenarios.push(spreadScenario(await pickManyDeals(hs, pool, N)));
  if (wantChurn) scenarios.push(churnScenario(await pickManyDeals(hs, pool, LINKS)));

  const totalOps = scenarios.reduce((n, s) => n + s.ops, 0);
  out.plannedOps = Object.fromEntries(scenarios.map((s) => [s.name, s.ops]));
  console.log('\nPlan (only fresh links between EXISTING records; no records created or deleted):');
  for (const s of scenarios) console.log(s.plan.join('\n') + `\n  = ${s.ops} association operations\n`);
  console.log(`Total: ${totalOps} association operations (cap ${MAX_OPS}${scenario === 'mixed' ? '; burst and spread run at the same time' : ''}).`);
  console.log(`Rate limit: <= ${TOOL_RATE_PER_10S} requests / 10 s (the portal bucket of this run).`);
  if (problems.length) console.log(`\nPre-check problems:\n  - ${problems.join('\n  - ')}`);

  if (totalOps > MAX_OPS) {
    console.error(`\n${totalOps} operations is above the cap of ${MAX_OPS}. Lower --n/--links/--flips or pass --max-ops ${totalOps}.`);
    process.exitCode = 1;
    return;
  }
  if (!yes) return console.log('\nDry run. Nothing was changed. Re-run with --yes to execute.');
  if (problems.length || !db) {
    console.error('\nNot touching HubSpot until the pre-check problems above are fixed.');
    process.exitCode = 1;
    return;
  }

  // --- run
  process.on('SIGINT', () => {
    if (abortState.aborted) process.exit(130);
    abortState.aborted = true;
    console.log('\nCtrl+C: stopping and cleaning up (press again to quit WITHOUT cleanup)...');
  });
  const ctx: Ctx = { hs, db, labels, checks: [], out, kpis: [] };
  const healthBefore = await readHealth(config.worker);
  const dbBytesBefore = dbFileSize(DB_PATH);
  const sampler = new Sampler(db);
  sampler.start();
  const t0 = Date.now();
  try {
    await Promise.all(scenarios.map((s) => s.run(ctx)));
  } finally {
    sampler.stop();
  }
  out.durationMs = Date.now() - t0;
  out.associationOpsUsed = budget.used;
  out.hubspotCalls = hs.calls;
  const scriptPeak = windowPeak(hs.times, 10_000);
  out.rateLimiterPeakPer10s = scriptPeak;
  out.hubspotErrors = hs.errors;
  if (hs.errors.length) check(ctx, scenario, 'HubSpot batch errors', false, `${hs.errors.length}: ${hs.errors.slice(0, 2).join(' | ')}`);
  check(ctx, scenario, 'usage', null, `${budget.used} association ops, ${hs.calls} API calls, peak ${scriptPeak} req/10 s, ${secs(out.durationMs as number)} total`);

  out.checks = ctx.checks;
  const pass = printTable(ctx.checks);
  save(out, scenario, pass ? 'pass' : 'fail');

  // KPI scorecard (always printed after a real run; separate from the functional PASS/FAIL above).
  const healthAfter = await readHealth(config.worker);
  const sc = scorecard(ctx.kpis, { scenario, hs, sampler, healthBefore, healthAfter, dbBytesBefore, dbBytesAfter: dbFileSize(DB_PATH) });
  printScorecard(sc.rows, sc.verdict);
  const kpiOut = {
    at: iso(Date.now()), scenario, portalId: PORTAL_ID, targets: T, verdict: sc.verdict, summary: sc.summary, kpis: sc.rows, markdownRow: sc.markdown,
    perScenario: ctx.kpis.map(({ timings, ...k }) => ({ ...k, timingsCount: timings.length })), timings: ctx.kpis.flatMap((k) => k.timings),
    healthBefore, healthAfter,
  };
  const kf = samplePath(config.tools.samplesDir, `load-kpis-${scenario}`);
  writeFileSync(kf, JSON.stringify(kpiOut, null, 2));
  console.log(`Saved: ${kf}`);
  console.log(`\nMarkdown row for ${KPI_DOC}:\n${sc.markdown}`);
  if (APPEND_KPIS) {
    if (!existsSync(KPI_DOC)) {
      mkdirSync(dirname(KPI_DOC), { recursive: true });
      writeFileSync(KPI_DOC, `# ChangeCatch load-test KPIs\n\nOne row per run of tools/src/load-test.ts (see tools/README.md).\n\n${KPI_MD_HEADER}\n`);
    }
    appendFileSync(KPI_DOC, sc.markdown + '\n');
    console.log(`Appended to ${KPI_DOC}.`);
  } else console.log(`(add --append-kpis to append it automatically)`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FAILED:', (e as Error).message);
  process.exitCode = 1;
});
