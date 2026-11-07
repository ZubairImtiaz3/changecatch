// SQLite production settings: pragmas, the one versioned migration list, indexes (EXPLAIN QUERY PLAN on the real
// statements), chunked prunes, one purge over every per-portal table, TTLs, read-only open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decryptToken, keyIdOf, parseKeyring } from '../lib/crypto.js';
import { CHANGE_LOG_SQL } from './change-log.js';
import { Store, footprintSql, purgeSql } from './db.js';
import { ENTRY_SQL } from './entries.js';
import { SEEN_SQL } from './journal-state.js';
import { LABEL_CACHE_RETENTION_MS, LABEL_SQL } from './labels.js';
import { memoryLogger } from '../../test/fixtures/log.js';
import { PRUNE_UNINSTALLED_SQL, PortalStore, UNINSTALLED_PORTAL_RETENTION_MS, pruneUninstalledPortals } from './portals.js';
import { MIGRATIONS, PORTAL_TABLES, PORTAL_TABLES_KEPT, SCHEMA_SCOPE, migrateSchema } from './schema.js';
import {
  Db, PRUNE_CHUNK_ROWS, pruneSql, runMigrations, schemaVersion,
} from './sqlite.js';
import { STAMP_SQL } from './stamps.js';

const b64 = () => randomBytes(32).toString('base64');
const KEY = parseKeyring(`t:${randomBytes(32).toString('base64')}`);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 30);

function tmpDb(): { path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lw-store-'));
  return { path: join(dir, 'changecatch.db'), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const pragma = (db: DatabaseSync, name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0];
const plan = (db: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(' | ');
const count = (db: DatabaseSync, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

// The worker and the API server open one file from two processes: WAL + a busy timeout let them share it.
test('pragmas: both stores on one file get WAL, FKs and a busy timeout', () => {
  const t = tmpDb();
  const store = new Store(t.path);
  const portals = new PortalStore({ path: t.path, key: KEY });
  try {
    for (const db of [store.db, portals.db]) {
      assert.equal(pragma(db, 'journal_mode'), 'wal');
      assert.equal(pragma(db, 'foreign_keys'), 1);
      assert.ok(Number(pragma(db, 'busy_timeout')) > 0);
    }
  } finally {
    store.close();
    portals.close();
    t.done();
  }
});

test('migrations: one list for the whole file, idempotent; both stores on one file share it', () => {
  const t = tmpDb();
  try {
    const s = new Store(t.path);
    assert.equal(schemaVersion(s.db, SCHEMA_SCOPE), MIGRATIONS.at(-1)!.version);
    assert.deepEqual(migrateSchema(s.db, memoryLogger().log), [], 're-run applies nothing');
    s.close();
    const p = new PortalStore({ path: t.path, key: KEY });
    const rows = p.db.prepare('SELECT scope, version FROM schema_migrations ORDER BY scope, version').all() as { scope: string; version: number }[];
    assert.deepEqual(rows.map((r) => `${r.scope}#${r.version}`), MIGRATIONS.map((m) => `store#${m.version}`));
    p.close();
  } finally {
    t.done();
  }
});

test('migrations: a dev DB from before the 2026-11-07 squash is refused with a clear message (never mixed)', () => {
  const olds = [
    // Old history: v1 under its old name, later versions, legacy scope 'portals'.
    `CREATE TABLE schema_migrations (scope TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (scope, version));
     INSERT INTO schema_migrations VALUES ('store', 1, 'initial schema', 1), ('store', 13, 'labels_synced table', 1), ('portals', 1, 'x', 1);`,
    // Before versioning: tables but no history.
    'CREATE TABLE seen_events (key TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);',
  ];
  for (const sql of olds) {
    const t = tmpDb();
    try {
      const db = new DatabaseSync(t.path);
      db.exec(sql);
      db.close();
      assert.throws(() => new Store(t.path), (e: Error) => e.message.startsWith('dev DB predates the squash: delete ') && e.message.includes('changecatch.db'));
      assert.throws(() => new PortalStore({ path: t.path, key: KEY }), /dev DB predates the squash/);
    } finally {
      t.done();
    }
  }
});

test('migrations log: fresh schema = one debug line; each upgrade step = one info record (component store); re-runs log nothing', () => {
  const mem = memoryLogger('store');
  {
    const db = new DatabaseSync(':memory:');
    const steps = [
      { version: 1, name: 'create a', up: (d: DatabaseSync) => d.exec('CREATE TABLE a (x)') },
      { version: 2, name: 'add a.y', up: (d: DatabaseSync) => d.exec('ALTER TABLE a ADD COLUMN y TEXT') },
    ];
    // Fresh schema: one debug summary line.
    assert.deepEqual(runMigrations(db, 't', [steps[0]], mem.log), [1]);
    assert.equal(mem.records.length, 1);
    assert.equal(mem.records[0].level, 'debug');
    // Upgrade: one info record per applied step.
    assert.deepEqual(runMigrations(db, 't', steps, mem.log), [2]);
    assert.equal(mem.records.length, 2);
    assert.deepEqual([mem.records[1].level, mem.records[1].component, mem.records[1].version], ['info', 'store', 2]);
    assert.deepEqual(runMigrations(db, 't', steps, mem.log), []);
    assert.equal(mem.records.length, 2, 're-run logs nothing');
  }
});

test('migrations: a failing step rolls back and is not marked applied', () => {
  const db = new DatabaseSync(':memory:');
  const steps = [
    { version: 1, name: 'ok', up: (d: DatabaseSync) => d.exec('CREATE TABLE a (x)') },
    { version: 2, name: 'boom', up: (d: DatabaseSync) => { d.exec('CREATE TABLE b (x)'); throw new Error('boom'); } },
  ];
  assert.throws(() => runMigrations(db, 't', steps, memoryLogger().log), /boom/);
  assert.equal(schemaVersion(db, 't'), 1);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'b'").get(), undefined, 'step 2 rolled back');
  assert.throws(() => runMigrations(db, 't', [steps[0], { ...steps[0] }], memoryLogger().log), /duplicate/);
});

test('EXPLAIN QUERY PLAN: the real hot statements use an index (no full table scans, no temp sort on the queue)', () => {
  const s = new Store(':memory:');
  const db = s.db;
  const prune = (table: string, col: string) => pruneSql(table, col, PRUNE_CHUNK_ROWS);
  const purge = (table: string) => purgeSql(PORTAL_TABLES.find((t) => t.table === table)!);
  const cases: [string, string, RegExp][] = [
    ['prune seen_events', prune('seen_events', 'seen_at'), /USING (COVERING )?INDEX seen_events_seen_at/],
    ['prune change_log', prune('change_log', 'created_at'), /USING (COVERING )?INDEX change_log_created_at/],
    ['prune stamp_last', prune('stamp_last', 'stamped_at'), /USING (COVERING )?INDEX stamp_last_stamped_at/],
    ['prune association_labels', prune('association_labels', 'updated_at'), /USING (COVERING )?INDEX association_labels_updated_at/],
    ['prune label_cache', prune('label_cache', 'fetched_at'), /USING (COVERING )?INDEX label_cache_fetched_at/],
    ['prune label_cache_fetches', prune('label_cache_fetches', 'fetched_at'), /USING (COVERING )?INDEX label_cache_fetches_fetched_at/],
    ['prune emitted_actions', prune('emitted_actions', 'created_at'), /USING (COVERING )?INDEX emitted_actions_created_at/],
    ['nextDueAt: unpaused', STAMP_SQL.nextUnpausedDue, /SCAN stamp_queue USING (COVERING )?INDEX stamp_queue_due_order/],
    ['nextDueAt: probe', STAMP_SQL.nextProbe, /USING (COVERING )?INDEX stamp_queue_portal_due_order/],
    ['firstQueuedFor', STAMP_SQL.firstQueuedFor, /USING INDEX stamp_queue_record_order/],
    ['queuedFor', STAMP_SQL.queuedFor, /USING INDEX stamp_queue_record_order/],
    ['queuedCountFor', STAMP_SQL.queuedCountFor, /USING (COVERING )?INDEX stamp_queue_record_order/],
    ['filterSeen', SEEN_SQL.filterSeen, /USING (COVERING )?INDEX sqlite_autoindex_seen_events_1/],
    ['getLastStampAt', STAMP_SQL.getLastStampAt, /USING INDEX sqlite_autoindex_stamp_last_1/],
    ['getLabel', LABEL_SQL.getLabel, /USING INDEX sqlite_autoindex_label_cache_1/],
    ['getChange', CHANGE_LOG_SQL.getChange, /USING INDEX sqlite_autoindex_change_log_1/],
    ['loadParked', ENTRY_SQL.loadParked, /SCAN parked_entries USING INDEX parked_entries_parked_at/],
    ['drain: portalsWithDue', STAMP_SQL.portalsWithDue, /USING (COVERING )?INDEX stamp_queue_portal_due_order/],
    ['drain: dueForPortal', STAMP_SQL.dueForPortal, /USING INDEX stamp_queue_portal_due_order/],
    ['portals prune', PRUNE_UNINSTALLED_SQL, /USING INDEX portals_uninstalled_at/],
    ['purge change_log', purge('change_log'), /USING (COVERING )?INDEX change_log_portal_occurred/],
    ['purge stamp_queue', purge('stamp_queue'), /USING (COVERING )?INDEX stamp_queue_portal_due_order/],
    ['purge parked_entries', purge('parked_entries'), /USING (COVERING )?INDEX parked_entries_portal/],
    ['purge emitted_actions', purge('emitted_actions'), /USING (COVERING )?INDEX emitted_actions_portal/],
    ['purge stamp_dead_letter', purge('stamp_dead_letter'), /USING (COVERING )?INDEX stamp_dead_letter_portal/],
    ['purge association_labels', purge('association_labels'), /USING (COVERING )?INDEX sqlite_autoindex_association_labels_1/],
    ['purge stamp_last', purge('stamp_last'), /USING (COVERING )?INDEX sqlite_autoindex_stamp_last_1/],
    ['purge label_holds', purge('label_holds'), /USING (COVERING )?INDEX sqlite_autoindex_label_holds_1/],
  ];
  for (const [name, sql, want] of cases) {
    const args = (sql.match(/\?/g) ?? []).map(() => 1);
    const detail = plan(db, sql, ...args);
    assert.match(detail, want, `${name}: ${detail}`);
    assert.doesNotMatch(detail, /USE TEMP B-TREE/, `${name} sorts in a temp b-tree: ${detail}`);
  }
  // Every purge/footprint statement is indexed, except the two tiny tables matched by content.
  const scanned = new Set(['worker_state', 'pending_pairs']);
  for (const t of PORTAL_TABLES.filter((x) => !scanned.has(x.table)))
    for (const sql of [purgeSql(t), footprintSql(t)]) {
      const detail = plan(db, sql, ...t.args(1));
      assert.doesNotMatch(detail, new RegExp(`(^| )SCAN ${t.table}( |$)`), `${t.table}: ${detail}`);
    }
  s.close();
});

test('prunes: chunked (removes everything old, chunk by chunk), never touches fresh rows', () => {
  const s = new Store(':memory:');
  const n = PRUNE_CHUNK_ROWS * 2 + 7;
  s.seen.markSeen(Array.from({ length: n }, (_, i) => `old${i}`), T0);
  s.seen.markSeen(['fresh'], T0 + 5 * DAY);
  assert.equal(s.seen.pruneSeen(T0 + 5 * DAY), n);
  assert.deepEqual(s.seen.filterSeen(['fresh', 'old0']), new Set(['fresh']));
  assert.equal(s.seen.pruneSeen(T0 + 5 * DAY), 0);

  s.stamps.setLastStampAt(['1|0-3|1', '1|0-3|2'], T0);
  s.stamps.setLastStampAt(['1|0-3|3'], T0 + DAY);
  assert.equal(s.stamps.pruneStampLast(T0 + DAY + 1), 2);
  s.labels.setAssociationLabels('1|a', ['X'], T0);
  assert.equal(s.labels.pruneAssociationLabels(T0 + 89 * DAY), 0);
  assert.equal(s.labels.pruneAssociationLabels(T0 + 91 * DAY), 1);
  s.close();
});

test('label_cache TTL: a pair not re-fetched for 30 days is dropped as a whole; fresh pairs stay', () => {
  const s = new Store(':memory:');
  s.labels.replaceLabels(1, '0-3', '0-1', [{ associationTypeId: 3, label: null, category: 'HUBSPOT_DEFINED' }, { associationTypeId: 9, label: 'Influencer', category: 'USER_DEFINED' }], T0);
  s.labels.replaceLabels(1, '0-1', '0-3', [{ associationTypeId: 4, label: null, category: 'HUBSPOT_DEFINED' }], T0 + 20 * DAY);
  assert.equal(s.labels.pruneLabelCache(T0 + LABEL_CACHE_RETENTION_MS - 1), 0);
  assert.equal(s.labels.pruneLabelCache(T0 + LABEL_CACHE_RETENTION_MS + 1), 3); // 2 labels + 1 fetch marker
  assert.deepEqual(s.labels.listLabels(1, '0-3', '0-1'), []);
  assert.equal(s.labels.getLabelsFetchedAt(1, '0-3', '0-1'), null, 'next lookup re-fetches');
  assert.equal(s.labels.listLabels(1, '0-1', '0-3').length, 1);
  s.close();
});

test('purgePortal: one statement per PORTAL_TABLES entry; key-range deletes hit only that portal (12 must not touch 123 or 1)', () => {
  const s = new Store(':memory:');
  for (const p of ['1', '12', '123']) {
    s.labels.setAssociationLabels(`${p}|0-3|1|0-1|2`, ['A'], T0);
    s.stamps.setLastStampAt([`${p}|0-3|1`], T0);
    s.labels.noteLabelHold(`${p}|0-3|0-1`, T0, 'x');
    s.labels.setSyncedTypeIds(Number(p), '0-3', '0-1', [1]);
    s.labels.setSyncedTypeIds(Number(p), '0-3', '0-1', [1], 'mirror');
  }
  const pend = (portalId: number) => ({ entry: { key: `k${portalId}`, event: { portalId } }, holdUntil: T0 }) as never;
  s.entries.replacePending([pend(1), pend(12), pend(123)]);
  s.journal.setState('journal_fail', '1');
  const out = s.purgePortal(12);
  assert.equal(out.association_labels, 1);
  assert.equal(out.stamp_last, 1);
  assert.equal(out.label_holds, 1);
  assert.equal(out.labels_synced, 2);
  assert.equal(out.pending_pairs, 1);
  assert.ok(Object.values(s.portalFootprint(12)).every((n) => n === 0));
  assert.equal(count(s.db, 'association_labels'), 2);
  assert.ok(s.labels.getAssociationLabels('123|0-3|1|0-1|2') && s.labels.getAssociationLabels('1|0-3|1|0-1|2'));
  assert.deepEqual(s.labels.getSyncedTypeIds(123, '0-3', '0-1', 'mirror'), [1]);
  assert.equal(s.journal.getState('journal_fail'), '1', 'app-level state is not portal data');
  assert.deepEqual(s.entries.loadPending().map((x) => x.entry.key).sort(), ['k1', 'k123']);
  assert.equal(s.portalFootprint(123).labels_synced, 2);
  s.close();
});

test('PORTAL_TABLES: every table with a portal_id column is purged (or deliberately kept)', () => {
  const s = new Store(':memory:');
  const tables = (s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  const withPortal = tables.filter((t) => (s.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === 'portal_id'));
  const declared = new Set([...PORTAL_TABLES.map((t) => t.table), ...PORTAL_TABLES_KEPT]);
  assert.deepEqual(withPortal.filter((t) => !declared.has(t)), []);
  for (const t of PORTAL_TABLES) assert.ok(tables.includes(t.table), `${t.table} exists`);
  s.close();
});

test('read-only Store: no migrations, no writes; reads what the worker wrote', () => {
  const t = tmpDb();
  try {
    const w = new Store(t.path);
    new PortalStore({ db: w.conn, key: KEY }).setWatchedPairs(5, [{ objectTypeId: '0-3', associatedObjectTypeId: '0-1' }]);
    w.journal.setOffset('off-1', T0);
    w.journal.setLastSuccessfulReadAt(T0);
    w.changes.saveChanges([{ changeId: 'c1', portalId: 5, objectTypeId: '0-3', objectId: '10', changeType: 'ADDED', otherObjectType: '0-1',
      otherRecordId: '20', labelBefore: 'none', labelAfter: 'none', labelsCurrent: 'none', associationCategory: 'HUBSPOT_DEFINED',
      occurredAt: new Date(T0).toISOString() }], T0);
    w.changes.markSuperseded(5, 'c1', 'c2');
    w.seen.markSeen(['stamp:c1'], T0 + 5);
    w.close();
    const r = new Store(t.path, { readOnly: true });
    try {
      assert.equal(r.journal.getOffset(), 'off-1');
      assert.equal(r.journal.getLastSuccessfulReadAt(), T0);
      const rp = new PortalStore({ db: r.conn, key: KEY });
      assert.deepEqual(rp.getWatchedPairs(5), [{ objectTypeId: '0-3', associatedObjectTypeId: '0-1' }]);
      assert.equal(rp.getPortal(5), undefined, 'no portals row');
      const rows = r.changes.changesForRecords(5, '0-3', ['10', '11'], T0);
      assert.deepEqual(rows.map((x) => [x.changeId, x.supersededBy]), [['c1', 'c2']]);
      assert.deepEqual(r.changes.changesForRecords(5, '0-3', ['10'], T0 + 1), []);
      assert.deepEqual([...r.seen.stampHandledAt(['c1', 'c9'])], [['c1', T0 + 5]]);
      assert.equal(r.stamps.queuedCountFor(['5|0-3|10']), 0);
      assert.throws(() => r.journal.setOffset('x'), /readonly|read-only/i);
    } finally {
      r.close();
    }
  } finally {
    t.done();
  }
});

test('transaction: nested calls join the outer one; a throw rolls everything back', () => {
  const s = new Store(':memory:');
  assert.throws(() =>
    s.transaction(() => {
      s.journal.setState('consecutive_empty', '1');
      s.seen.markSeen(['k'], T0); // nests (markSeen opens its own transaction when none is open)
      s.transaction(() => s.journal.setState('journal_offset_check', '2'));
      throw new Error('stop');
    }),
  );
  assert.equal(s.journal.getState('consecutive_empty'), undefined);
  assert.equal(s.journal.getState('journal_offset_check'), undefined);
  assert.equal(s.seen.filterSeen(['k']).size, 0);
  assert.equal(s.db.isTransaction, false);
  assert.equal(s.transaction(() => 42), 42);
  s.close();
});

test('portals: uninstall keeps only id + time, row deleted after 30 days; installed portals never pruned', () => {
  const p = new PortalStore({ path: ':memory:', key: KEY });
  p.saveInstall(1, 'rt-1', ['crm.objects.deals.read'], T0);
  p.setStampSpacingSeconds(1, 10, T0);
  p.markProvisioned(1, 'boom', T0);
  p.saveInstall(2, 'rt-2', ['x'], T0);
  p.markUninstalled(1, T0 + DAY);
  const raw = p.db.prepare('SELECT * FROM portals WHERE portal_id = 1').get() as Record<string, unknown>;
  assert.equal(raw.refresh_token_enc, null);
  assert.equal(raw.scopes, '');
  assert.equal(raw.installed_at, null);
  assert.equal(raw.last_provision_error, null);
  assert.equal(raw.provisioned_at, null);
  assert.equal(raw.uninstalled_at, T0 + DAY);
  const c = new Db(p.db);
  assert.equal(pruneUninstalledPortals(c, T0 + DAY + UNINSTALLED_PORTAL_RETENTION_MS - 1), 0);
  assert.equal(pruneUninstalledPortals(c, T0 + DAY + UNINSTALLED_PORTAL_RETENTION_MS + 1), 1);
  assert.equal(p.getPortal(1), undefined);
  assert.ok(p.isInstalled(2));
  // Reinstall after uninstall works and starts clean.
  p.saveInstall(1, 'rt-1b', ['y'], T0 + 40 * DAY);
  assert.equal(p.getRefreshToken(1), 'rt-1b');
  p.close();
});

// ---------------------------------------------------------------- PortalStore: tokens, revocations, rotation

test('PortalStore keeps the refresh token encrypted at rest', () => {
  const s = new PortalStore({ path: ':memory:', key: KEY });
  s.saveInstall(111, 'rt-secret', ['oauth'], 1);
  const raw = s.db.prepare('SELECT refresh_token_enc FROM portals WHERE portal_id = ?').get(111) as { refresh_token_enc: string };
  assert.ok(!raw.refresh_token_enc.includes('rt-secret'));
  assert.equal(s.getRefreshToken(111), 'rt-secret');
  assert.deepEqual(s.getPortal(111)?.scopes, ['oauth']);
});

test('rotation: old-key rows are re-encrypted with the active key (dry run writes nothing)', () => {
  const k1 = b64();
  const k2 = b64();
  // Day 1: TOKEN_ENC_KEYS=k1. Day 2: rotate to k2.
  const day1 = parseKeyring(`k1:${k1}`);
  const store = new PortalStore({ path: ':memory:', key: day1 });
  store.saveInstall(1, 'rt-k1', []);
  // A row whose key id is no longer configured.
  store.db.prepare('INSERT INTO portals (portal_id, refresh_token_enc, scopes, installed_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(3, 'kgone:AAAA:AAAA:AAAA', '', 1, 1);

  const day2 = parseKeyring(`k2:${k2},k1:${k1}`);
  const rotator = new PortalStore({ db: store.conn, key: day2 }); // TOKEN_ENC_KEYS on day 2, same file
  const dry = rotator.rotateTokens();
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldReencrypt, 1);
  assert.equal(dry.reencrypted, 0);
  assert.deepEqual(dry.byKeyId, { k1: 1, gone: 1 });
  assert.equal(dry.failed.length, 1);
  assert.equal(keyIdOf((store.db.prepare('SELECT refresh_token_enc e FROM portals WHERE portal_id = 1').get() as { e: string }).e), 'k1', 'dry run wrote nothing');

  const applied = rotator.rotateTokens({ dryRun: false });
  assert.equal(applied.reencrypted, 1);
  // Old key removed: the row is still readable with k2 alone.
  const e = (store.db.prepare('SELECT refresh_token_enc e FROM portals WHERE portal_id = 1').get() as { e: string }).e;
  assert.equal(keyIdOf(e), 'k2');
  assert.equal(decryptToken(e, parseKeyring(`k2:${k2}`), '1'), 'rt-k1');
  assert.equal(rotator.rotateTokens({ dryRun: false }).reencrypted, 0, 'second run is a no-op');
  // New writes through the store use the active key.
  const s2 = new PortalStore({ path: ':memory:', key: day2 });
  s2.saveInstall(9, 'rt-new', []);
  assert.equal(s2.getRefreshToken(9), 'rt-new');
  assert.equal(keyIdOf((s2.db.prepare('SELECT refresh_token_enc e FROM portals WHERE portal_id = 9').get() as { e: string }).e), 'k2');
  s2.close();
  store.close();
});

test('portals: token revocations (ignored once not newer than the latest install)', () => {
  const p = new PortalStore({ path: ':memory:', key: KEY });
  p.saveInstall(1, 'rt-1', [], 100);
  assert.equal(p.revokedAt(1), null);
  p.markRevoked(1, 200);
  p.markRevoked(1, 300);
  assert.equal(p.revokedAt(1), 200, 'the first rejection is kept');
  assert.deepEqual(p.listRevoked(), [{ portalId: 1, revokedAt: 200 }]);
  p.saveInstall(1, 'rt-1b', [], 400);
  assert.equal(p.revokedAt(1), null, 'a reinstall after the rejection hides it');
  p.markRevoked(1, 500);
  assert.equal(p.revokedAt(1), 500, 'a rejection after the reinstall replaces the old row');
  p.saveInstall(1, 'rt-1c', [], 500);
  assert.deepEqual(p.listRevoked(), [], 'a reinstall in the same millisecond wins');
  p.markRevoked(1, 500);
  assert.deepEqual(p.listRevoked(), [], 'a same-millisecond rejection does not count against that install');
  p.markRevoked(1, 501);
  assert.equal(p.revokedAt(1), 501, 'a later rejection replaces the same-millisecond row');
  p.close();
});

test('portals: a PortalStore on a shared connection never closes it', () => {
  const s = new Store(':memory:');
  const p = new PortalStore({ db: s.conn, key: KEY });
  p.saveInstall(5, 'rt-5', [], 1);
  p.close();
  assert.ok(s.db.isOpen);
  assert.deepEqual(p.getWatchedPairs(5), [], 'still usable: the connection is open');
  assert.equal(p.getRefreshToken(5), 'rt-5');
  s.close();
});

test('change_log: saveChanges is idempotent, getChange is scoped by portal, prune after 30 days', () => {
  const store = new Store(':memory:');
  const r = { changeId: 'c1', portalId: 111, objectTypeId: '0-3', objectId: '1', changeType: 'LABEL_CHANGED' as const, otherObjectType: '0-1',
    otherRecordId: '2', labelBefore: '0-1:101', labelAfter: '0-1:102', labelsCurrent: '0-1:102', associationCategory: 'USER_DEFINED',
    occurredAt: new Date(T0).toISOString() };
  store.changes.saveChanges([r], T0);
  store.changes.saveChanges([{ ...r, labelAfter: 'changed' }], T0 + 1);
  const got = store.changes.getChange(111, r.changeId);
  assert.equal(got?.labelAfter, '0-1:102', 'first write wins');
  assert.equal(got?.createdAt, T0);
  assert.equal(store.changes.getChange(222, r.changeId), undefined, 'other portal cannot read it');
  assert.equal(store.changes.pruneChangeLog(T0 + 29 * DAY), 0);
  assert.equal(store.changes.pruneChangeLog(T0 + 31 * DAY), 1);
  assert.equal(store.changes.getChange(111, r.changeId), undefined);
});

test('seen_events pruning removes keys older than 4 days', () => {
  const store = new Store(':memory:');
  store.seen.markSeen(['old'], T0 - 5 * DAY);
  store.seen.markSeen(['new'], T0 - 1 * DAY);
  assert.equal(store.seen.pruneSeen(T0), 1);
  assert.deepEqual([...store.seen.filterSeen(['old', 'new'])], ['new']);
});

test('store: watched pairs and offsets round-trip', () => {
  const store = new Store(':memory:');
  assert.equal(store.journal.getOffset(), null);
  store.journal.setOffset('abc');
  assert.equal(store.journal.getOffset(), 'abc');
  const portals = new PortalStore({ db: store.conn, key: KEY });
  portals.setWatchedPairs(111, [{ objectTypeId: '0-3', associatedObjectTypeId: '0-1' }]);
  portals.setWatchedPairs(111, [{ objectTypeId: '2-1', associatedObjectTypeId: '0-1' }]);
  assert.deepEqual(portals.getWatchedPairs(111), [{ objectTypeId: '2-1', associatedObjectTypeId: '0-1' }]);
  assert.deepEqual(portals.getWatchedPairs(222), []);
});
