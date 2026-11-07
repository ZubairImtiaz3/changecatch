// When the worker loop reads the journal next.
//
// Latency target (2026-10-30): most changes stamped within ~10 s of occurredAt. HubSpot publishes a journal
// file ~1-4 s after occurredAt, and the Journal API limit (100 req/s per app) is separate from customers'
// limits; there is ONE app-wide stream for all portals. So a steady short interval costs almost nothing,
// while an idle back-off (e.g. 60 s -> 120 s) would make a single UI change wait up to 2 min.

import { backoffMs } from '../lib/backoff.js';

export interface DelayConfig {
  /** Steady interval between reads (JOURNAL_POLL_MS). */
  pollMs: number;
  /** First delay after a failed run, then doubles. */
  errorBaseMs: number;
  /** Cap for the error back-off. */
  errorMaxMs: number;
}

export const DEFAULT_DELAY_CONFIG: DelayConfig = {
  pollMs: 3_000,
  errorBaseMs: 5_000,
  errorMaxMs: 120_000,
};

/** Full batch -> read again now (more is waiting). Otherwise the steady poll interval. */
export function nextDelayMs(batchFull: boolean, c: DelayConfig): number {
  return batchFull ? 0 : c.pollMs;
}

/** Exponential back-off after failed runs: errorBaseMs, x2, x4 ... capped at errorMaxMs. Separate from polling. */
export function errorDelayMs(consecutiveErrors: number, c: DelayConfig): number {
  return backoffMs(consecutiveErrors - 1, c.errorBaseMs, c.errorMaxMs);
}
