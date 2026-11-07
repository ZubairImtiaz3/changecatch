// Table metrics: only the last error per portal, shown on /health. Counts live in the in-memory metrics
// (src/obs/metrics.ts). Schema in schema.ts.

import type { Db } from './sqlite.js';

export class MetricsStore {
  constructor(private readonly c: Db) {}

  /** Last error for one portal (shown on /health). Never pass token values in here. */
  recordPortalError(portalId: number, message: string, now: number): void {
    this.c.stmt(
        `INSERT INTO metrics (portal_id, last_error, last_error_at) VALUES (?, ?, ?)
         ON CONFLICT(portal_id) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`,
      )
      .run(portalId, message.slice(0, 500), now);
  }
  listPortalErrors(): { portalId: number; message: string; at: number }[] {
    const rows = this.c.stmt('SELECT portal_id, last_error, last_error_at FROM metrics WHERE last_error IS NOT NULL ORDER BY portal_id').all() as {
      portal_id: number;
      last_error: string;
      last_error_at: number | null;
    }[];
    return rows.map((r) => ({ portalId: Number(r.portal_id), message: String(r.last_error), at: Number(r.last_error_at ?? 0) }));
  }
}
