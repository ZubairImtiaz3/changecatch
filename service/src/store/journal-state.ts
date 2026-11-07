// The journal reader's own state: the shared offset (journal_offset), the processed-key set (seen_events) and the
// small app-level key/value table (worker_state). Schema in schema.ts.

import { STAMP_PREFIX } from '../core/keys.js';
import type { Db } from './sqlite.js';

export const SEEN_RETENTION_MS = 4 * 24 * 60 * 60 * 1000; // journal keeps ~3 days; keep a day more

/** Hot statements, used as-is below and planned by store.test.ts (EXPLAIN QUERY PLAN). */
export const SEEN_SQL = {
  filterSeen: 'SELECT 1 FROM seen_events WHERE key = ?',
} as const;

/** Fixed worker_state keys (app-level, never portal-scoped). */
export const WORKER_STATE_KEYS = [
  'created_at',
  'last_successful_read_at',
  'last_error',
  'consecutive_empty',
  'journal_offset_check',
  'journal_fail',
] as const;
export type WorkerStateKey = (typeof WORKER_STATE_KEYS)[number];

export class JournalState {
  constructor(private readonly c: Db) {}

  // --- journal_offset ---
  getOffset(): string | null {
    const row = this.c.stmt('SELECT offset FROM journal_offset WHERE id = 1').get() as { offset: string } | undefined;
    return row?.offset ?? null;
  }
  setOffset(offset: string, now: number = Date.now()): void {
    this.c.stmt('INSERT INTO journal_offset (id, offset, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at')
      .run(offset, now);
  }

  // --- worker_state ---
  getState(key: WorkerStateKey): string | undefined {
    const row = this.c.stmt('SELECT value FROM worker_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }
  setState(key: WorkerStateKey, value: string): void {
    this.c.stmt('INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  deleteState(key: WorkerStateKey): void {
    this.c.stmt('DELETE FROM worker_state WHERE key = ?').run(key);
  }
  getCreatedAt(): number {
    return Number(this.getState('created_at'));
  }
  getLastSuccessfulReadAt(): number | null {
    const v = this.getState('last_successful_read_at');
    return v === undefined ? null : Number(v);
  }
  setLastSuccessfulReadAt(ms: number): void {
    this.setState('last_successful_read_at', String(ms));
  }
  recordError(message: string, now: number): void {
    this.setState('last_error', JSON.stringify({ message, at: now }));
  }
  getLastError(): { message: string; at: number } | null {
    const v = this.getState('last_error');
    return v ? JSON.parse(v) : null;
  }
}

/** seen_events: journal entry keys plus the stamp markers (STAMP_PREFIX / SENT_PREFIX + change id). */
export class SeenEvents {
  constructor(private readonly c: Db) {}

  filterSeen(keys: string[]): Set<string> {
    const stmt = this.c.stmt(SEEN_SQL.filterSeen);
    return new Set(keys.filter((k) => stmt.get(k) !== undefined));
  }
  markSeen(keys: string[], now: number = Date.now()): void {
    if (!keys.length) return;
    const stmt = this.c.stmt('INSERT OR IGNORE INTO seen_events (key, seen_at) VALUES (?, ?)');
    this.c.transaction(() => {
      for (const k of keys) stmt.run(k, now);
    });
  }
  /** change id -> when its stamp was handled (seen key STAMP_PREFIX: sent, coalesced or dead-lettered). */
  stampHandledAt(changeIds: string[]): Map<string, number> {
    const q = this.c.stmt('SELECT seen_at FROM seen_events WHERE key = ?');
    const out = new Map<string, number>();
    for (const id of changeIds) {
      const r = q.get(STAMP_PREFIX + id) as { seen_at: number } | undefined;
      if (r) out.set(id, Number(r.seen_at));
    }
    return out;
  }
  pruneSeen(now: number = Date.now(), maxAgeMs: number = SEEN_RETENTION_MS): number {
    return this.c.pruneOlderThan('seen_events', 'seen_at', now - maxAgeMs);
  }
}
