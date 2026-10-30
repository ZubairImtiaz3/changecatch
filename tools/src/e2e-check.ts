// End-to-end check: a REAL association change goes in, a stamped deal comes out.
// It does NOT start the worker. Start the service first (`pnpm --filter @changecatch/service dev` or start:worker).
//
// Usage (from tools/):
//   pnpm exec tsx src/e2e-check.ts --portal <portalId> --deal <dealId>         -> dry run: plan + read-only pre-checks
//   pnpm exec tsx src/e2e-check.ts --portal <portalId> --deal <dealId> --yes   -> runs it (3 association changes, then cleanup)
//   options: --gap 30 (s between steps)  --timeout 120 (s to wait for each stamp)
//            --contact <id> (force the contact; must NOT be linked to the deal)
//            --labels "A,B" (two Deal->Contact label names; type IDs are looked up by name; see lib/test-labels.ts)
//   --portal falls back to HUBSPOT_TEST_PORTAL_ID. No defaults for portal or deal.
//
// Tokens (never printed):
//   - app client credentials token (journal subscriptions)       -> service/src/hubspot/journal.ts
//   - HUBSPOT_SETUP_TOKEN service key (makes the association changes)
//   - portal OAuth token (reads the deal's changecatch_* properties) -> getToolPortalToken() (lib/portal-token.ts)
//
// Endpoints (docs checked 2026-10-30):
//   Labels:  GET  /crm/associations/2026-09/0-3/0-1/labels
//            https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associations-schema/guide.md
//   Link:    PUT  /crm/objects/2026-09/0-3/{dealId}/associations/0-1/{contactId}   body [{associationCategory, associationTypeId}]
//            (PUT ADDS labels, it does not replace them)
//   Unlabel: POST /crm/associations/2026-09/0-3/0-1/batch/labels/archive
//   Unlink:  DELETE /crm/objects/2026-09/0-3/{dealId}/associations/0-1/{contactId}
//            https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide.md
//   Read:    GET  /crm/objects/2026-09/0-3/{dealId}?properties=...
//
// The worker DB (DB_PATH, see lib/paths.ts) is opened READ-ONLY. Creates and deletes NO records.

import { env, optionalEnv } from './lib/env.js'; // must stay first
import { writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { hsRequest } from '@changecatch/service/lib/http.js';
import { listSubscriptions, type Subscription } from '@changecatch/service/hubspot/journal.js';
import { STAMP_PROPS } from '@changecatch/service/core/stamp.js';
import { labelOptionValue, splitValues } from '@changecatch/service/core/label-options.js';
import { parseArgs, portalIdFrom } from './lib/cli.js';
import { dbPath, samplePath } from './lib/paths.js';
import { getToolPortalToken } from './lib/portal-token.js';
import { labelByName, testLabelNames } from './lib/test-labels.js';

const V = '2026-09';
const DEAL = '0-3';
const CONTACT = '0-1';
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const yes = flag('--yes');
const parsed = parseArgs(args);
const PORTAL_ID = portalIdFrom(parsed);
const DEAL_ARG = opt('--deal');
if (!DEAL_ARG || !/^\d+$/.test(DEAL_ARG)) {
  console.error('Usage: tsx src/e2e-check.ts --portal <portalId> --deal <dealId> [--yes] [--contact <id>] [--labels "A,B"] [--gap 30] [--timeout 120]');
  process.exit(1);
}
const DEAL_ID: string = DEAL_ARG;
const [LABEL_A, LABEL_B] = testLabelNames(parsed, 2);
const gapSec = Number(opt('--gap')) || 30;
const timeoutSec = Number(opt('--timeout')) || 120;
const forcedContact = opt('--contact');
const DB_PATH = dbPath();
const HEALTH_PORT = Number(optionalEnv('WORKER_HEALTH_PORT') ?? 3002);
const POLL_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

type Label = { category: string; typeId: number; label: string | null };
type Props = Record<string, string | null>;

interface CheckRow {
  check: string;
  pass: boolean;
  detail: string;
  latencyMs?: number;
}
const rows: CheckRow[] = [];
const out: Record<string, unknown> = { startedAt: now(), portalId: PORTAL_ID, dealId: DEAL_ID, dbPath: DB_PATH, steps: [] as unknown[] };
const record = (r: CheckRow) => {
  rows.push(r);
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.check}: ${r.detail}${r.latencyMs !== undefined ? ` (${(r.latencyMs / 1000).toFixed(1)} s)` : ''}`);
};

// ------------------------------------------------------------------ HubSpot helpers

const setupToken = () => env('HUBSPOT_SETUP_TOKEN');

const listLabels = async () =>
  (await hsRequest<{ results: Label[] }>(`/crm/associations/${V}/${DEAL}/${CONTACT}/labels`, { token: setupToken() })).results;

async function linkTypes(dealId: string, contactId: string): Promise<unknown[]> {
  const r = await hsRequest<{ results: { toObjectId: number | string; associationTypes: unknown[] }[] }>(
    `/crm/objects/${V}/${DEAL}/${dealId}/associations/${CONTACT}`,
    { token: setupToken(), query: { limit: 500 } },
  );
  return r.results.find((x) => String(x.toObjectId) === String(contactId))?.associationTypes ?? [];
}

async function freeContact(dealId: string): Promise<string> {
  const linked = await hsRequest<{ results: { toObjectId: number | string }[] }>(
    `/crm/objects/${V}/${DEAL}/${dealId}/associations/${CONTACT}`,
    { token: setupToken(), query: { limit: 500 } },
  );
  const taken = new Set(linked.results.map((x) => String(x.toObjectId)));
  const contacts = await hsRequest<{ results: { id: string }[] }>(`/crm/objects/${V}/${CONTACT}`, { token: setupToken(), query: { limit: 50 } });
  const free = contacts.results.map((c) => c.id).find((id) => !taken.has(id));
  if (!free) throw new Error(`No contact among the first 50 is free (all linked to deal ${dealId}). Pass --contact <id>.`);
  return free;
}

const spec = (l: Label) => ({ associationCategory: l.category, associationTypeId: l.typeId });
const putLabels = (d: string, c: string, labels: Label[]) =>
  hsRequest(`/crm/objects/${V}/${DEAL}/${d}/associations/${CONTACT}/${c}`, { method: 'PUT', token: setupToken(), body: labels.map(spec) });
const archiveLabels = (d: string, c: string, labels: Label[]) =>
  hsRequest(`/crm/associations/${V}/${DEAL}/${CONTACT}/batch/labels/archive`, {
    method: 'POST',
    token: setupToken(),
    body: { inputs: [{ from: { id: d }, to: { id: c }, types: labels.map(spec) }] },
  });
const unlink = (d: string, c: string) =>
  hsRequest(`/crm/objects/${V}/${DEAL}/${d}/associations/${CONTACT}/${c}`, { method: 'DELETE', token: setupToken() });

const PROP_LIST = Object.values(STAMP_PROPS);
async function dealProps(): Promise<Props> {
  const token = await getToolPortalToken({ portalId: PORTAL_ID });
  const r = await hsRequest<{ properties: Props }>(`/crm/objects/${V}/${DEAL}/${DEAL_ID}`, {
    token,
    query: { properties: PROP_LIST.join(',') },
  });
  return r.properties ?? {};
}

// ------------------------------------------------------------------ local DB (read-only)

function openDb(): DatabaseSync | null {
  if (!existsSync(DB_PATH)) return null;
  try {
    return new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (e) {
    console.warn(`  could not open ${DB_PATH} read-only: ${(e as Error).message}`);
    return null;
  }
}

function changeRow(db: DatabaseSync | null, changeId: string): Record<string, unknown> | undefined {
  if (!db) return undefined;
  // Same lookup as Store.getChange (portal_id is part of the key).
  return db.prepare('SELECT * FROM change_log WHERE change_id = ? AND portal_id = ?').get(changeId, PORTAL_ID) as Record<string, unknown> | undefined;
}

function watchedPairs(db: DatabaseSync | null): { object_type_id: string; associated_object_type_id: string }[] {
  if (!db) return [];
  return db.prepare('SELECT object_type_id, associated_object_type_id FROM portal_settings WHERE portal_id = ?').all(PORTAL_ID) as {
    object_type_id: string;
    associated_object_type_id: string;
  }[];
}

// ------------------------------------------------------------------ pre-checks (read-only)

function coversDealContact(s: Subscription): 'deal-side' | 'contact-side' | null {
  if (s.subscriptionType !== 'ASSOCIATION' || Number(s.portalId) !== PORTAL_ID || s.deletedAt) return null;
  const acts = s.actions ?? [];
  if (!acts.includes('ASSOCIATION_ADDED') || !acts.includes('ASSOCIATION_REMOVED')) return null;
  if (s.objectTypeId === DEAL && (s.associatedObjectTypeIds ?? []).includes(CONTACT)) return 'deal-side';
  if (s.objectTypeId === CONTACT && (s.associatedObjectTypeIds ?? []).includes(DEAL)) return 'contact-side';
  return null;
}

async function preChecks(db: DatabaseSync | null): Promise<boolean> {
  console.log('\n== Pre-checks (read-only)');
  let ok = true;

  // (a) journal subscriptions
  try {
    const subs = await listSubscriptions();
    const hits = subs.map((s) => ({ s, side: coversDealContact(s) })).filter((x) => x.side);
    out.subscriptions = hits.map((h) => ({ id: h.s.id, objectTypeId: h.s.objectTypeId, associatedObjectTypeIds: h.s.associatedObjectTypeIds, actions: h.s.actions, objectIds: h.s.objectIds }));
    const dealSide = hits.find((h) => h.side === 'deal-side');
    if (dealSide) record({ check: 'subscription Deal->Contact', pass: true, detail: `id ${dealSide.s.id}, actions ${dealSide.s.actions.join('+')}` });
    else if (hits.length)
      record({ check: 'subscription Deal->Contact', pass: false, detail: `only Contact->Deal subs (${hits.map((h) => h.s.id).join(',')}). Events then come from the contact; deal is stamped only with STAMP_MIRROR=1` });
    else record({ check: 'subscription Deal->Contact', pass: false, detail: `no ASSOCIATION sub with ADDED+REMOVED for portal ${PORTAL_ID} (install the app with the pair 0-3:0-1 watched, or create the subscription)` });
    ok &&= !!dealSide;
  } catch (e) {
    record({ check: 'subscription Deal->Contact', pass: false, detail: `list failed: ${(e as Error).message}` });
    ok = false;
  }

  // worker-side filter: portal_settings must contain the pair, or the worker drops the events
  if (!db) {
    record({ check: 'local DB', pass: false, detail: `${DB_PATH} not found / not readable. Is the worker using the same DB_PATH?` });
    ok = false;
  } else {
    const pairs = watchedPairs(db);
    const has = pairs.some(
      (p) => (p.object_type_id === DEAL && p.associated_object_type_id === CONTACT) || (p.object_type_id === CONTACT && p.associated_object_type_id === DEAL),
    );
    record({ check: 'watched pair 0-3:0-1 in DB', pass: has, detail: has ? 'present' : `missing (have: ${pairs.map((p) => `${p.object_type_id}:${p.associated_object_type_id}`).join(', ') || 'none'}). Set WORKER_SEED_WATCHED_PAIRS=0-3:0-1` });
    ok &&= has;
  }

  // worker health endpoint (informational only: a FAIL here does not block)
  try {
    const res = await fetch(`http://localhost:${HEALTH_PORT}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    out.healthBefore = body;
    record({ check: 'worker /health', pass: res.ok, detail: `HTTP ${res.status}, lastSuccessfulReadAt ${String(body.lastSuccessfulReadAt)}` });
  } catch (e) {
    record({ check: 'worker /health', pass: false, detail: `not reachable on :${HEALTH_PORT} (${(e as Error).message}). Is the worker running?` });
    ok = false;
  }

  // OAuth token + properties exist on the deal
  try {
    const p = await dealProps();
    out.dealPropsBefore = p;
    const missing = PROP_LIST.filter((n) => !(n in p));
    record({ check: 'deal readable with OAuth token', pass: missing.length === 0, detail: missing.length ? `missing props: ${missing.join(', ')}` : `last change id ${p[STAMP_PROPS.changeId] ?? '(empty)'}` });
    ok &&= missing.length === 0;
  } catch (e) {
    record({ check: 'deal readable with OAuth token', pass: false, detail: (e as Error).message });
    ok = false;
  }
  return ok;
}

// ------------------------------------------------------------------ steps

interface Expect {
  changeType: 'ADDED' | 'LABEL_CHANGED' | 'REMOVED';
  beforeHas?: string; // option value that must be in changecatch_label_before
  afterHas?: string; // option value that must be in changecatch_label_after
}

function matches(p: Props, contactId: string, e: Expect, baselineChangeId: string | null): string | null {
  if (!p[STAMP_PROPS.changeId] || p[STAMP_PROPS.changeId] === baselineChangeId) return 'no new change id yet';
  if (p[STAMP_PROPS.otherRecordId] !== contactId) return `other_record_id ${p[STAMP_PROPS.otherRecordId]} != ${contactId}`;
  if (p[STAMP_PROPS.changeType] !== e.changeType) return `change_type ${p[STAMP_PROPS.changeType]} != ${e.changeType}`;
  if (e.beforeHas && !splitValues(p[STAMP_PROPS.labelBefore]).includes(e.beforeHas)) return `label_before "${p[STAMP_PROPS.labelBefore]}" lacks ${e.beforeHas}`;
  if (e.afterHas && !splitValues(p[STAMP_PROPS.labelAfter]).includes(e.afterHas)) return `label_after "${p[STAMP_PROPS.labelAfter]}" lacks ${e.afterHas}`;
  return null;
}

async function runStep(db: DatabaseSync | null, name: string, contactId: string, action: () => Promise<unknown>, e: Expect) {
  console.log(`\n== [${now()}] ${name}`);
  const baseline = (await dealProps())[STAMP_PROPS.changeId] ?? null;
  const t0 = Date.now();
  let actionError: string | undefined;
  try {
    await action();
  } catch (err) {
    actionError = (err as Error).message;
  }
  const tAction = Date.now();
  const step: Record<string, unknown> = { name, expect: e, baselineChangeId: baseline, actionStartedAt: new Date(t0).toISOString(), actionEndedAt: new Date(tAction).toISOString() };
  (out.steps as unknown[]).push(step);
  if (actionError) {
    step.actionError = actionError;
    record({ check: `${name}: action`, pass: false, detail: actionError });
    return false;
  }
  step.linkAfter = await linkTypes(DEAL_ID, contactId).catch((err) => `read failed: ${(err as Error).message}`);

  // (c) poll the deal until the stamp matches
  let last: Props = {};
  let why = 'not polled';
  let stampedAt: number | undefined;
  let otherStamps = 0;
  let seenId = baseline;
  while (Date.now() - tAction < timeoutSec * 1000) {
    await sleep(POLL_MS);
    try {
      last = await dealProps();
    } catch (err) {
      why = `read failed: ${(err as Error).message}`;
      continue;
    }
    const id = last[STAMP_PROPS.changeId] ?? null;
    why = matches(last, contactId, e, baseline) ?? '';
    if (!why) {
      stampedAt = Date.now();
      break;
    }
    // A different new stamp (e.g. someone else touched the deal) is reported, and we keep waiting.
    if (id && id !== seenId) {
      otherStamps++;
      seenId = id;
    }
  }
  step.dealPropsAfter = last;
  step.otherStampsSeen = otherStamps;
  if (stampedAt === undefined) {
    record({ check: `${name}: deal stamped`, pass: false, detail: `timeout ${timeoutSec}s; last reason: ${why}` });
    return false;
  }
  const latencyMs = stampedAt - tAction;
  step.latencyMs = latencyMs;
  // Change ids start with the change's occurredAt in epoch ms ("<ms>-<hex>"); changecatch_last_change_at was cut (D5).
  const changeAt = Number(String(last[STAMP_PROPS.changeId] ?? '').split('-')[0]);
  if (Number.isFinite(changeAt) && changeAt > 0) step.occurredToStampMs = stampedAt - changeAt;
  record({ check: `${name}: deal stamped`, pass: true, detail: `${e.changeType}, id ${last[STAMP_PROPS.changeId]}, before ${last[STAMP_PROPS.labelBefore]}, after ${last[STAMP_PROPS.labelAfter]}`, latencyMs });

  // (d) change_log row
  const row = changeRow(db, String(last[STAMP_PROPS.changeId]));
  step.changeLogRow = row ?? null;
  const rowOk = !!row && String(row.object_id) === DEAL_ID && row.change_type === e.changeType && String(row.other_record_id) === contactId;
  record({ check: `${name}: change_log row`, pass: rowOk, detail: row ? `${row.change_type} ${row.object_type_id}/${row.object_id} -> ${row.other_record_id}` : db ? 'not found' : 'DB not readable' });
  return true;
}

// ------------------------------------------------------------------ main

const PLAN = `
ChangeCatch end-to-end check, portal ${PORTAL_ID}, Deal ${DEAL_ID}. The worker must already be running.
Pre-checks (read-only): journal subscription Deal<->Contact, watched pair in ${DB_PATH}, worker /health on :${HEALTH_PORT},
  deal readable with the portal OAuth token.
Then, with the service key, on a contact NOT linked to the deal (C):
  1  link Deal-C WITH label "${LABEL_A}"   -> expect ADDED, label_after has 0-1:${LABEL_A}
  2  PUT "${LABEL_B}", archive "${LABEL_A}" -> expect LABEL_CHANGED, before 0-1:${LABEL_A}, after 0-1:${LABEL_B}
  3  remove the whole association                   -> expect REMOVED
After each step: poll the deal every ${POLL_MS / 1000}s for up to ${timeoutSec}s, then check the change_log row. ${gapSec}s gap between steps.
Cleanup: the association is removed at the end even on failure. No records created or deleted.`;

function printTable() {
  console.log('\n== Result');
  const w = Math.max(...rows.map((r) => r.check.length), 5);
  console.log(`${'CHECK'.padEnd(w)}  RESULT  LATENCY   DETAIL`);
  for (const r of rows)
    console.log(`${r.check.padEnd(w)}  ${(r.pass ? 'PASS' : 'FAIL').padEnd(6)}  ${(r.latencyMs !== undefined ? `${(r.latencyMs / 1000).toFixed(1)} s` : '-').padEnd(8)}  ${r.detail}`);
  const allPass = rows.length > 0 && rows.every((r) => r.pass);
  console.log(`\nOVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
  return allPass;
}

function save(kind: string) {
  out.endedAt = now();
  out.checks = rows;
  const file = samplePath(`e2e-${kind}`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Saved: ${file}`);
}

async function main() {
  console.log(PLAN);
  const db = openDb();
  const ready = await preChecks(db);

  if (!yes) {
    printTable();
    console.log('\nDry run. Nothing was changed. Re-run with --yes to execute.');
    return;
  }
  if (!ready) {
    printTable();
    save('aborted');
    console.log('\nPre-checks failed: not touching HubSpot. Fix the FAIL rows above first.');
    process.exitCode = 1;
    return;
  }

  const labels = await listLabels();
  const inf = labelByName(labels, LABEL_A);
  const dm = labelByName(labels, LABEL_B);
  const C = forcedContact ?? (await freeContact(DEAL_ID));
  if (forcedContact && (await linkTypes(DEAL_ID, C)).length) throw new Error(`Contact ${C} is already linked to deal ${DEAL_ID}.`);
  out.contactId = C;
  out.labels = { first: inf, second: dm };
  console.log(`\nContact C=${C}; ${LABEL_A}=${inf.typeId}, ${LABEL_B}=${dm.typeId}`);

  const INF = labelOptionValue(CONTACT, LABEL_A);
  const DM = labelOptionValue(CONTACT, LABEL_B);
  try {
    const s1 = await runStep(db, `1 ADDED (${LABEL_A})`, C, () => putLabels(DEAL_ID, C, [inf]), { changeType: 'ADDED', afterHas: INF });
    if (s1) {
      await sleep(gapSec * 1000);
      const s2 = await runStep(db, `2 LABEL_CHANGED (${LABEL_A} -> ${LABEL_B})`, C, async () => {
        await putLabels(DEAL_ID, C, [dm]);
        await archiveLabels(DEAL_ID, C, [inf]);
      }, { changeType: 'LABEL_CHANGED', beforeHas: INF, afterHas: DM });
      if (s2) await sleep(gapSec * 1000);
    }
    // Step 3 always runs: it is both a check and the cleanup.
    await runStep(db, '3 REMOVED', C, () => unlink(DEAL_ID, C), { changeType: 'REMOVED' });
  } finally {
    // Cleanup: whatever happened above, leave Deal <-> C unlinked.
    const still = await linkTypes(DEAL_ID, C).catch(() => ['unknown']);
    if (still.length) {
      try {
        await unlink(DEAL_ID, C);
        console.log(`\nCleanup: removed Deal ${DEAL_ID} <-> Contact ${C}.`);
      } catch (e) {
        console.error(`\nCleanup FAILED, remove Deal ${DEAL_ID} <-> Contact ${C} by hand: ${(e as Error).message}`);
      }
    }
    out.linkAtEnd = await linkTypes(DEAL_ID, C).catch((e) => `read failed: ${(e as Error).message}`);
  }

  const pass = printTable();
  save(pass ? 'pass' : 'fail');
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FAILED:', (e as Error).message);
  if (rows.length) {
    printTable();
    save('error');
  }
  process.exitCode = 1;
});
