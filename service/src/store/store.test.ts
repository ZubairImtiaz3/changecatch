// SQLite production settings: pragmas, versioned migrations, indexes (EXPLAIN QUERY PLAN), chunked prunes,
// purge by key range, TTLs, statement cache..
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LABEL_CACHE_RETENTION_MS, PRUNE_CHUNK_ROWS, PRUNE_CHUNK_ROWS_IN_TX, STORE_MIGRATIONS, Store, StatementCache, pipePrefixRange,
  addColumnIfMissing, runMigrations, schemaVersion, setStoreLogger,
} from './db.js';
import { memoryLogger } from '../obs/log.js';
import { PORTAL_MIGRATIONS, PortalStore, UNINSTALLED_PORTAL_RETENTION_MS } from './portals.js';

const KEY = randomBytes(32);
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

test('pragmas: both stores on one file get WAL, NORMAL sync, FKs, autocheckpoint, memory temp store, busy timeout', () => {
  const t = tmpDb();
  const store = new Store(t.path);
  const portals = new PortalStore({ path: t.path, key: KEY });
  try {
    for (const db of [store.db, portals.db]) {
      assert.equal(pragma(db, 'journal_mode'), 'wal');
      assert.equal(pragma(db, 'synchronous'), 1); // NORMAL
      assert.equal(pragma(db, 'foreign_keys'), 1);
      assert.equal(pragma(db, 'wal_autocheckpoint'), 1000);
      assert.equal(pragma(db, 'temp_store'), 2); // MEMORY
      assert.equal(pragma(db, 'busy_timeout'), 5000);
    }
    assert.equal(pragma(store.db, 'auto_vacuum'), 2, 'a brand-new file gets INCREMENTAL auto_vacuum');
    assert.deepEqual(store.runMaintenance(T0), { seen_events: 0, change_log: 0, stamp_last: 0, association_labels: 0, label_cache: 0, emitted_actions: 0 });
  } finally {
    store.close();
    portals.close();
    t.done();
  }
});

test('migrations: versioned per scope, idempotent, and upgrade a pre-versioning database in place', () => {
  const t = tmpDb();
  try {
    // A DB from before versioning: old tables, old index, no metrics columns added later, data present.
    const old = new DatabaseSync(t.path);
    old.exec(`CREATE TABLE seen_events (key TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
      CREATE TABLE metrics (portal_id INTEGER PRIMARY KEY, events_processed INTEGER NOT NULL DEFAULT 0,
        changes_emitted INTEGER NOT NULL DEFAULT 0, occurrences_sent INTEGER NOT NULL DEFAULT 0, last_event_at INTEGER);
      CREATE TABLE stamp_queue (change_id TEXT PRIMARY KEY, portal_id INTEGER NOT NULL, record_key TEXT NOT NULL,
        update_json TEXT NOT NULL, not_before INTEGER NOT NULL, occurred_at_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX stamp_queue_record ON stamp_queue (record_key);
      INSERT INTO seen_events VALUES ('k1', 1);
      INSERT INTO metrics (portal_id, events_processed) VALUES (7, 3);`);
    old.close();

    const s = new Store(t.path);
    assert.equal(schemaVersion(s.db, 'store'), STORE_MIGRATIONS.at(-1)!.version);
    assert.deepEqual(s.filterSeen(['k1', 'k2']), new Set(['k1']), 'old data kept');
    assert.equal(s.getMetrics(7)?.eventsProcessed, 3);
    assert.equal(s.getMetrics(7)?.stampsSent, 0, 'column added by migration 2');
    const idx = (s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    assert.ok(!idx.includes('stamp_queue_record') && idx.includes('stamp_queue_record_order'));
    assert.deepEqual(runMigrations(s.db, 'store', STORE_MIGRATIONS), [], 're-run applies nothing');
    s.close();

    // Second open (and the other store on the same file) is a no-op for 'store' and applies 'portals' on its own.
    const s2 = new Store(t.path);
    const p = new PortalStore({ path: t.path, key: KEY });
    assert.equal(schemaVersion(p.db, 'portals'), PORTAL_MIGRATIONS.at(-1)!.version);
    const rows = s2.db.prepare('SELECT scope, version FROM schema_migrations ORDER BY scope, version').all() as { scope: string; version: number }[];
    assert.deepEqual(rows.map((r) => `${r.scope}#${r.version}`), [
      ...PORTAL_MIGRATIONS.map((m) => `portals#${m.version}`),
      ...STORE_MIGRATIONS.map((m) => `store#${m.version}`),
    ]);
    s2.close();
    p.close();
  } finally {
    t.done();
  }
});

test('migrations log: fresh schema = one debug line; each upgrade step = one info record (component store); re-runs log nothing', () => {
  const mem = memoryLogger('store');
  const restore = setStoreLogger(mem.log);
  try {
    const db = new DatabaseSync(':memory:');
    const steps = [
      { version: 1, name: 'create a', up: (d: DatabaseSync) => d.exec('CREATE TABLE a (x)') },
      { version: 2, name: 'add a.y', up: (d: DatabaseSync) => addColumnIfMissing(d, 'a', 'y', 'TEXT') },
    ];
    // Fresh schema: one debug summary line.
    assert.deepEqual(runMigrations(db, 't', [steps[0]]), [1]);
    assert.equal(mem.records.length, 1);
    assert.equal(mem.records[0].level, 'debug');
    assert.equal(mem.records[0].event, 'schema_created');
    assert.deepEqual(mem.records[0].versions, [1]);
    // Upgrade: one info record per applied step.
    assert.deepEqual(runMigrations(db, 't', steps), [2]);
    assert.equal(mem.records.length, 2);
    const r = mem.records[1];
    assert.equal(r.level, 'info');
    assert.equal(r.component, 'store');
    assert.equal(r.event, 'migration_applied');
    assert.equal(r.scope, 't');
    assert.equal(r.version, 2);
    assert.equal(r.name, 'add a.y');
    assert.equal(typeof r.durationMs, 'number');
    assert.equal(r.msg, 't migration 2 applied: add a.y');
    assert.deepEqual(runMigrations(db, 't', steps), []);
    assert.equal(mem.records.length, 2, 're-run logs nothing');
  } finally {
    restore();
  }
});

test('migrations: a failing step rolls back and is not marked applied', () => {
  const db = new DatabaseSync(':memory:');
  const steps = [
    { version: 1, name: 'ok', up: (d: DatabaseSync) => d.exec('CREATE TABLE a (x)') },
    { version: 2, name: 'boom', up: (d: DatabaseSync) => { d.exec('CREATE TABLE b (x)'); throw new Error('boom'); } },
  ];
  assert.throws(() => runMigrations(db, 't', steps), /boom/);
  assert.equal(schemaVersion(db, 't'), 1);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'b'").get(), undefined, 'step 2 rolled back');
  assert.throws(() => runMigrations(db, 't', [steps[0], { ...steps[0] }]), /duplicate/);
});

test('EXPLAIN QUERY PLAN: hot queries use an index (no full table scans, no temp sort on the queue)', () => {
  const s = new Store(':memory:');
  const p = new PortalStore({ path: ':memory:', key: KEY });
  const db = s.db;
  const prune = (table: string, col: string) => `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${col} < ? LIMIT 5000)`;
  const cases: [string, string, RegExp][] = [
    ['prune seen_events', prune('seen_events', 'seen_at'), /USING (COVERING )?INDEX seen_events_seen_at/],
    ['prune change_log', prune('change_log', 'created_at'), /USING (COVERING )?INDEX change_log_created_at/],
    ['prune stamp_last', prune('stamp_last', 'stamped_at'), /USING (COVERING )?INDEX stamp_last_stamped_at/],
    ['prune association_labels', prune('association_labels', 'updated_at'), /USING (COVERING )?INDEX association_labels_updated_at/],
    ['prune label_cache', prune('label_cache', 'fetched_at'), /USING (COVERING )?INDEX label_cache_fetched_at/],
    ['prune label_cache_fetches', prune('label_cache_fetches', 'fetched_at'), /USING (COVERING )?INDEX label_cache_fetches_fetched_at/],
    ['dueStamps', 'SELECT * FROM stamp_queue WHERE not_before <= ? ORDER BY not_before, occurred_at_ms, change_id LIMIT ?', /USING INDEX stamp_queue_due_order/],
    ['nextStampDueAt', 'SELECT MIN(not_before) AS m FROM stamp_queue', /USING (COVERING )?INDEX stamp_queue_(due_order|portal_due)/],
    ['firstQueuedFor', 'SELECT change_id, not_before FROM stamp_queue WHERE record_key = ? ORDER BY occurred_at_ms, change_id LIMIT 1', /USING INDEX stamp_queue_record_order/],
    ['maxQueuedNotBefore', 'SELECT MAX(not_before) AS m FROM stamp_queue WHERE record_key = ?', /USING INDEX stamp_queue_record_order/],
    ['filterSeen', 'SELECT 1 FROM seen_events WHERE key = ?', /USING (COVERING )?INDEX sqlite_autoindex_seen_events_1/],
    ['getLastStampAt', 'SELECT stamped_at FROM stamp_last WHERE record_key = ?', /USING INDEX sqlite_autoindex_stamp_last_1/],
    ['getLabel', 'SELECT label, category, fetched_at FROM label_cache WHERE portal_id = ? AND from_type = ? AND to_type = ? AND type_id = ?', /USING INDEX sqlite_autoindex_label_cache_1/],
    ['getChange', 'SELECT * FROM change_log WHERE change_id = ? AND portal_id = ?', /USING INDEX sqlite_autoindex_change_log_1/],
    ['purge change_log', 'DELETE FROM change_log WHERE portal_id = ?', /USING (COVERING )?INDEX change_log_portal_occurred/],
    ['purge stamp_queue', 'DELETE FROM stamp_queue WHERE portal_id = ?', /USING (COVERING )?INDEX stamp_queue_portal_due/],
    ['purge parked_entries', 'DELETE FROM parked_entries WHERE portal_id = ?', /USING (COVERING )?INDEX parked_entries_portal/],
    ['purge association_labels', 'DELETE FROM association_labels WHERE pair_key >= ? AND pair_key < ?', /USING (COVERING )?INDEX sqlite_autoindex_association_labels_1/],
    ['purge stamp_last', 'DELETE FROM stamp_last WHERE record_key >= ? AND record_key < ?', /USING (COVERING )?INDEX sqlite_autoindex_stamp_last_1/],
    ['purge label_holds', 'DELETE FROM label_holds WHERE hold_key >= ? AND hold_key < ?', /USING (COVERING )?INDEX sqlite_autoindex_label_holds_1/],
    ['loadParked', 'SELECT entry_json, parked_at FROM parked_entries ORDER BY parked_at, key', /SCAN parked_entries USING INDEX parked_entries_parked_at/],
  ];
  for (const [name, sql, want] of cases) {
    const args = (sql.match(/\?/g) ?? []).map(() => 1);
    const detail = plan(db, sql, ...args);
    assert.match(detail, want, `${name}: ${detail}`);
    assert.doesNotMatch(detail, /USE TEMP B-TREE/, `${name} sorts in a temp b-tree: ${detail}`);
  }
  const pp = plan(p.db, `DELETE FROM portals WHERE rowid IN (SELECT rowid FROM portals WHERE uninstalled_at IS NOT NULL AND uninstalled_at < ? AND refresh_token_enc IS NULL LIMIT 5000)`, 1);
  assert.match(pp, /USING INDEX portals_uninstalled_at/, pp);
  s.close();
  p.close();
});

test('prunes: chunked outside a transaction (removes everything old), ONE small chunk inside a caller transaction', () => {
  const s = new Store(':memory:');
  const n = PRUNE_CHUNK_ROWS * 2 + 7;
  s.markSeen(Array.from({ length: n }, (_, i) => `old${i}`), T0);
  s.markSeen(['fresh'], T0 + 5 * DAY);
  // Inside the poller's offset transaction: bounded work.
  const inTx = s.transaction(() => s.pruneSeen(T0 + 5 * DAY));
  assert.equal(inTx, PRUNE_CHUNK_ROWS_IN_TX);
  // Outside: loops chunk by chunk until done; never touches fresh rows.
  assert.equal(s.pruneSeen(T0 + 5 * DAY), n - PRUNE_CHUNK_ROWS_IN_TX);
  assert.deepEqual(s.filterSeen(['fresh', 'old0']), new Set(['fresh']));
  assert.equal(s.pruneSeen(T0 + 5 * DAY), 0);

  s.setLastStampAt(['1|0-3|1', '1|0-3|2'], T0);
  s.setLastStampAt(['1|0-3|3'], T0 + DAY);
  assert.equal(s.pruneStampLast(T0 + DAY + 1), 2);
  s.setAssociationLabels('1|a', ['X'], T0);
  assert.equal(s.pruneAssociationLabels(T0 + 89 * DAY), 0);
  assert.equal(s.pruneAssociationLabels(T0 + 91 * DAY), 1);
  s.close();
});

test('label_cache TTL: a pair not re-fetched for 30 days is dropped as a whole; fresh pairs stay', () => {
  const s = new Store(':memory:');
  s.replaceLabels(1, '0-3', '0-1', [{ associationTypeId: 3, label: null, category: 'HUBSPOT_DEFINED' }, { associationTypeId: 9, label: 'Influencer', category: 'USER_DEFINED' }], T0);
  s.replaceLabels(1, '0-1', '0-3', [{ associationTypeId: 4, label: null, category: 'HUBSPOT_DEFINED' }], T0 + 20 * DAY);
  assert.equal(s.pruneLabelCache(T0 + LABEL_CACHE_RETENTION_MS - 1), 0);
  assert.equal(s.pruneLabelCache(T0 + LABEL_CACHE_RETENTION_MS + 1), 3); // 2 labels + 1 fetch marker
  assert.deepEqual(s.listLabels(1, '0-3', '0-1'), []);
  assert.equal(s.getLabelsFetchedAt(1, '0-3', '0-1'), null, 'next lookup re-fetches');
  assert.equal(s.listLabels(1, '0-1', '0-3').length, 1);
  s.close();
});

test('purgePortal: key-range deletes hit only that portal (12 must not touch 123 or 1)', () => {
  const s = new Store(':memory:');
  for (const p of ['1', '12', '123']) {
    s.setAssociationLabels(`${p}|0-3|1|0-1|2`, ['A'], T0);
    s.setLastStampAt([`${p}|0-3|1`], T0);
    s.noteLabelHold(`${p}|0-3|0-1`, T0, 'x');
    s.setState(`labels_synced:${p}|0-3|0-1`, '1');
    s.setState(`labels_synced:full:${p}|0-3|0-1`, '1');
  }
  const out = s.purgePortal(12);
  assert.equal(out.association_labels, 1);
  assert.equal(out.stamp_last, 1);
  assert.equal(out.label_holds, 1);
  assert.equal(out.worker_state, 2);
  assert.equal(count(s.db, 'association_labels'), 2);
  assert.ok(s.getAssociationLabels('123|0-3|1|0-1|2') && s.getAssociationLabels('1|0-3|1|0-1|2'));
  assert.equal(s.getState('labels_synced:full:123|0-3|0-1'), '1');
  assert.deepEqual(pipePrefixRange('12'), ['12|', '12}']);
  s.close();
});

test('transaction: nested calls join the outer one; a throw rolls everything back', () => {
  const s = new Store(':memory:');
  assert.throws(() =>
    s.transaction(() => {
      s.setState('a', '1');
      s.markSeen(['k'], T0); // nests (markSeen opens its own transaction when none is open)
      s.transaction(() => s.setState('b', '2'));
      throw new Error('stop');
    }),
  );
  assert.equal(s.getState('a'), undefined);
  assert.equal(s.getState('b'), undefined);
  assert.equal(s.filterSeen(['k']).size, 0);
  assert.equal(s.db.isTransaction, false);
  assert.equal(s.transaction(() => 42), 42);
  s.close();
});

test('statement cache: one prepare per SQL text', () => {
  const db = new DatabaseSync(':memory:');
  const c = new StatementCache(db);
  assert.equal(c.get('SELECT 1'), c.get('SELECT 1'));
  c.get('SELECT 2');
  assert.equal(c.size, 2);
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
  assert.equal(p.pruneUninstalled(T0 + DAY + UNINSTALLED_PORTAL_RETENTION_MS - 1), 0);
  assert.equal(p.pruneUninstalled(T0 + DAY + UNINSTALLED_PORTAL_RETENTION_MS + 1), 1);
  assert.equal(p.getPortal(1), undefined);
  assert.ok(p.isInstalled(2));
  // Reinstall after uninstall works and starts clean.
  p.saveInstall(1, 'rt-1b', ['y'], T0 + 40 * DAY);
  assert.equal(p.getRefreshToken(1), 'rt-1b');
  p.close();
});

test('migration 8: name-based label memory is cleared (labels are type-id keys now); other data kept', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, 'store', STORE_MIGRATIONS.filter((m) => m.version <= 7));
  db.exec(`
    INSERT INTO association_labels VALUES ('111|0-3|1|0-1|2', '["Influencer"]', 1);
    INSERT INTO emitted_actions VALUES ('a', 'r', 111, 'c1', 'ADDED', '0-1', NULL, '["Influencer"]', '[]', '["Influencer"]', 1, 1);
    INSERT INTO worker_state VALUES ('labels_synced:111|0-3|0-1', '[101]');
    INSERT INTO worker_state VALUES ('labels_synced:mirror:111|0-3|0-1', '[101]');
    INSERT INTO worker_state VALUES ('other_key', 'keep');
    INSERT INTO seen_events VALUES ('k1', 1);`);
  assert.deepEqual(runMigrations(db, 'store', STORE_MIGRATIONS), [8]);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  assert.equal(count('SELECT COUNT(*) AS n FROM association_labels'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM emitted_actions'), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM worker_state WHERE key LIKE 'labels_synced:%'"), 0, 'every pair re-syncs its dropdowns once');
  assert.equal((db.prepare("SELECT value FROM worker_state WHERE key = 'other_key'").get() as { value: string }).value, 'keep');
  assert.equal(count('SELECT COUNT(*) AS n FROM seen_events'), 1, 'unrelated tables untouched');
  db.close();
});
