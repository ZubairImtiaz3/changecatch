// Throttled exception writer: one log line (event "exception") per unexpected error that no caller logged itself
// (crashes, unhandled rejections, app route failures), redacted like every log line. The same error repeated (same
// fingerprint) is written at most once per `dedupeWindowMs` (default 5 min); the skipped count rides along on the next
// line, so a stuck loop cannot flood the log. Callers that already log the failure (log.error / log.alert) do not
// report it here as well: one problem = one line.

import { createLogger, redactString, type Logger } from './log.js';

/** Distinct fingerprints remembered for throttling (oldest dropped first). */
const MAX_FINGERPRINTS = 500;

export interface ErrorContext {
  portalId?: number;
  /** Short snake_case name of what was happening, e.g. "journal_read", "stamp_drain", "oauth_callback". */
  op?: string;
  /** Extra data. Redacted before it is written. */
  extra?: Record<string, unknown>;
}

/** Group errors by kind (op + error name + message), not by the numbers inside them (ids, offsets, ms). */
function fingerprintOf(err: unknown, ctx: ErrorContext = {}): string {
  const name = err instanceof Error ? err.name : 'message';
  const msg = err instanceof Error ? err.message : String(err);
  const shape = redactString(msg)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .slice(0, 200);
  return [ctx.op ?? '-', name, shape].join('|');
}

export interface ErrorsOptions {
  /** Where reports are written. Default: createLogger('errors'). */
  log?: Logger;
  dedupeWindowMs?: number;
  now?: () => number;
}

export class Errors {
  /** Where reports are written (its component names the source); startProcess sets the process logger. */
  log: Logger;
  private readonly dedupeWindowMs: number;
  private readonly now: () => number;
  private readonly lastSent = new Map<string, { at: number; skipped: number }>();

  constructor(opts: ErrorsOptions = {}) {
    this.log = opts.log ?? createLogger('errors');
    this.dedupeWindowMs = opts.dedupeWindowMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  /** Returns how many earlier copies were skipped (to attach), or -1 if this one should be skipped. */
  private gate(fp: string): number {
    const t = this.now();
    const prev = this.lastSent.get(fp);
    if (prev && t - prev.at < this.dedupeWindowMs) {
      prev.skipped++;
      return -1;
    }
    const skipped = prev?.skipped ?? 0;
    this.lastSent.delete(fp);
    this.lastSent.set(fp, { at: t, skipped: 0 });
    if (this.lastSent.size > MAX_FINGERPRINTS) this.lastSent.delete(this.lastSent.keys().next().value!);
    return skipped;
  }

  private fields(ctx: ErrorContext, skipped: number): Record<string, unknown> {
    return {
      ...(ctx.portalId !== undefined ? { portalId: ctx.portalId } : {}),
      ...(ctx.extra ?? {}),
      ...(skipped ? { suppressedSinceLast: skipped } : {}),
    };
  }

  /** Report an exception. Never throws. Returns false when throttled. */
  capture(err: unknown, ctx: ErrorContext = {}): boolean {
    try {
      const skipped = this.gate(fingerprintOf(err, ctx));
      if (skipped < 0) return false;
      const e = err instanceof Error ? err : new Error(String(err));
      this.log.error('exception', `${ctx.op ? ctx.op + ': ' : ''}${e.message}`, {
        ...this.fields(ctx, skipped),
        ...(ctx.op ? { op: ctx.op } : {}),
        error: err,
      });
      return true;
    } catch {
      return false;
    }
  }
}

/** Process-wide instance. */
export const errors = new Errors();

/**
 * Call once at process start: reports go to `log`; crashes are reported, then uncaughtException exits (state may be
 * broken; the platform restarts us). unhandledRejection is reported but does not exit.
 */
export function installProcessHandlers(log: Logger, target: Errors = errors, exit: (code: number) => void = (c) => process.exit(c)): void {
  target.log = log;
  process.on('unhandledRejection', (reason) => {
    target.capture(reason, { op: 'unhandled_rejection' });
  });
  process.on('uncaughtException', (err) => {
    target.capture(err, { op: 'uncaught_exception' });
    exit(1);
  });
}
