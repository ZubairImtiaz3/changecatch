// Error reporting with a pluggable backend.
//
// Default backend: the JSON logger (event "exception"). Free, always on.
// Optional backend: Sentry. Turn it on with ONE env var, after installing the SDK once:
//
//     pnpm --filter @changecatch/service add @sentry/node
//     SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>
//
// Optional: SENTRY_ENVIRONMENT (default NODE_ENV or "production"), SENTRY_RELEASE (e.g. git sha),
// SENTRY_TRACES_SAMPLE_RATE (default 0 = errors only, stays inside the free tier).
//
// If SENTRY_DSN is set but @sentry/node is not installed, we log one warning and keep the log backend.
// Everything sent anywhere goes through redact() first, so tokens never leave the process.
//
// Same error repeated (same fingerprint) is reported at most once per `dedupeWindowMs` (default 5 min);
// the skipped count rides along on the next report. This keeps a stuck loop from burning the
// Sentry free quota (5k errors/month) in an hour.

import { createLogger, redact, redactString, type Logger } from './log.js';

export type Severity = 'warning' | 'error' | 'fatal';

export interface ErrorContext {
  component?: string;
  portalId?: number;
  /** Short snake_case name of what was happening, e.g. "journal_read", "stamp_drain", "oauth_callback". */
  op?: string;
  /** Extra data. Redacted before it is sent. */
  extra?: Record<string, unknown>;
  /** Override grouping. Default: component + op + error name + message with numbers stripped. */
  fingerprint?: string;
  level?: Severity;
}

export interface ErrorReporter {
  readonly name: string;
  captureException(err: unknown, ctx: ErrorContext): void;
  captureMessage(msg: string, ctx: ErrorContext): void;
  /** Wait for queued reports to be sent (call before process exit). */
  flush(timeoutMs?: number): Promise<boolean>;
}

/** Backend that writes to the structured logger. */
export class LogReporter implements ErrorReporter {
  readonly name = 'log';
  constructor(private readonly log: Logger = createLogger('errors')) {}
  captureException(err: unknown, ctx: ErrorContext): void {
    const level = ctx.level === 'warning' ? 'warn' : 'error';
    const e = err instanceof Error ? err : new Error(String(err));
    this.log.log(level, 'exception', `${ctx.op ? ctx.op + ': ' : ''}${e.message}`, {
      ...(ctx.component ? { source: ctx.component } : {}),
      ...(ctx.portalId !== undefined ? { portalId: ctx.portalId } : {}),
      error: err,
      ...(ctx.extra ?? {}),
    });
  }
  captureMessage(msg: string, ctx: ErrorContext): void {
    this.log.log(ctx.level === 'warning' ? 'warn' : 'error', ctx.op ?? 'error_message', msg, {
      ...(ctx.component ? { source: ctx.component } : {}),
      ...(ctx.portalId !== undefined ? { portalId: ctx.portalId } : {}),
      ...(ctx.extra ?? {}),
    });
  }
  async flush(): Promise<boolean> {
    return true;
  }
}

/** Minimal shape of @sentry/node that we use (so we don't need its types installed). */
interface SentryLike {
  init(opts: Record<string, unknown>): void;
  withScope(cb: (scope: SentryScope) => void): void;
  captureException(err: unknown): string;
  captureMessage(msg: string, level?: string): string;
  flush(timeoutMs?: number): Promise<boolean>;
}
interface SentryScope {
  setTag(k: string, v: string): void;
  setExtras(e: Record<string, unknown>): void;
  setFingerprint(f: string[]): void;
  setLevel(l: string): void;
}

/** Backend that sends to Sentry. Build it with `createSentryReporter()`, or pass any Sentry-like object (tests). */
export class SentryReporter implements ErrorReporter {
  readonly name = 'sentry';
  constructor(private readonly sentry: SentryLike) {}
  private scoped(ctx: ErrorContext, fp: string, send: () => void): void {
    this.sentry.withScope((scope) => {
      if (ctx.component) scope.setTag('component', ctx.component);
      if (ctx.op) scope.setTag('op', ctx.op);
      if (ctx.portalId !== undefined) scope.setTag('portalId', String(ctx.portalId));
      if (ctx.extra) scope.setExtras(redact(ctx.extra) as Record<string, unknown>);
      scope.setFingerprint([fp]);
      scope.setLevel(ctx.level ?? 'error');
      send();
    });
  }
  captureException(err: unknown, ctx: ErrorContext): void {
    this.scoped(ctx, ctx.fingerprint ?? fingerprintOf(err, ctx), () => this.sentry.captureException(scrubError(err)));
  }
  captureMessage(msg: string, ctx: ErrorContext): void {
    this.scoped(ctx, ctx.fingerprint ?? fingerprintOf(msg, ctx), () => this.sentry.captureMessage(redactString(msg), ctx.level ?? 'error'));
  }
  flush(timeoutMs = 2000): Promise<boolean> {
    return this.sentry.flush(timeoutMs);
  }
}

/** Copy of an Error with message/stack redacted (Sentry reads both). */
function scrubError(err: unknown): unknown {
  if (!(err instanceof Error)) return new Error(redactString(String(err)));
  const copy = new Error(redactString(err.message));
  copy.name = err.name;
  if (err.stack) copy.stack = redactString(err.stack);
  return copy;
}

/** Load @sentry/node at runtime. Returns null (and says why) when it is not installed. */
export async function createSentryReporter(
  dsn: string,
  env: NodeJS.ProcessEnv = process.env,
  load: (mod: string) => Promise<unknown> = (m) => import(m),
): Promise<{ reporter: SentryReporter | null; reason?: string }> {
  let mod: any;
  try {
    const spec = '@sentry/node'; // variable on purpose: tsc must not require the package to exist
    mod = await load(spec);
  } catch (e) {
    return { reporter: null, reason: `@sentry/node is not installed (${(e as Error).message}). Run: pnpm --filter @changecatch/service add @sentry/node` };
  }
  const Sentry: SentryLike = mod.default ?? mod;
  Sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? 'production',
    release: env.SENTRY_RELEASE,
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    sendDefaultPii: false,
    // Last line of defence: redact the whole event (request headers, breadcrumbs, extras).
    beforeSend: (event: unknown) => redact(event, 0),
    beforeBreadcrumb: (b: unknown) => redact(b, 0),
  });
  return { reporter: new SentryReporter(Sentry) };
}

// ---------------------------------------------------------------------------------------------
// Fingerprints + throttling
// ---------------------------------------------------------------------------------------------

/** Group errors by kind, not by the numbers inside them (ids, offsets, ms). */
export function fingerprintOf(err: unknown, ctx: ErrorContext = {}): string {
  const name = err instanceof Error ? err.name : 'message';
  const msg = err instanceof Error ? err.message : String(err);
  const shape = redactString(msg)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .slice(0, 200);
  return [ctx.component ?? '-', ctx.op ?? '-', name, shape].join('|');
}

export interface ErrorsOptions {
  reporter?: ErrorReporter;
  dedupeWindowMs?: number;
  now?: () => number;
  /** Max distinct fingerprints remembered for throttling. */
  maxFingerprints?: number;
}

export class Errors {
  reporter: ErrorReporter;
  private readonly dedupeWindowMs: number;
  private readonly now: () => number;
  private readonly maxFp: number;
  private readonly lastSent = new Map<string, { at: number; skipped: number }>();

  constructor(opts: ErrorsOptions = {}) {
    this.reporter = opts.reporter ?? new LogReporter();
    this.dedupeWindowMs = opts.dedupeWindowMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.maxFp = opts.maxFingerprints ?? 500;
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
    if (this.lastSent.size > this.maxFp) this.lastSent.delete(this.lastSent.keys().next().value!);
    return skipped;
  }

  /** Report an exception. Never throws. Returns false when throttled. */
  capture(err: unknown, ctx: ErrorContext = {}): boolean {
    try {
      const fp = ctx.fingerprint ?? fingerprintOf(err, ctx);
      const skipped = this.gate(fp);
      if (skipped < 0) return false;
      const extra = skipped ? { ...(ctx.extra ?? {}), suppressedSinceLast: skipped } : ctx.extra;
      this.reporter.captureException(err, { ...ctx, fingerprint: fp, extra });
      return true;
    } catch {
      return false;
    }
  }

  /** Report a problem that is not an exception (e.g. "no successful journal read for 1 h"). */
  message(msg: string, ctx: ErrorContext = {}): boolean {
    try {
      const fp = ctx.fingerprint ?? fingerprintOf(msg, ctx);
      const skipped = this.gate(fp);
      if (skipped < 0) return false;
      const extra = skipped ? { ...(ctx.extra ?? {}), suppressedSinceLast: skipped } : ctx.extra;
      this.reporter.captureMessage(msg, { ...ctx, fingerprint: fp, extra });
      return true;
    } catch {
      return false;
    }
  }

  flush(timeoutMs = 2000): Promise<boolean> {
    return this.reporter.flush(timeoutMs).catch(() => false);
  }
}

/** Process-wide instance. `initErrorReporting()` swaps its backend to Sentry when SENTRY_DSN is set. */
export const errors = new Errors();

/**
 * Call once at process start (worker main, app server main). Picks the backend from env.
 * Returns the backend name ("sentry" or "log").
 */
export async function initErrorReporting(
  opts: { env?: NodeJS.ProcessEnv; log?: Logger; load?: (mod: string) => Promise<unknown>; target?: Errors } = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? createLogger('errors');
  const target = opts.target ?? errors;
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) {
    target.reporter = new LogReporter(log);
    return target.reporter.name;
  }
  const { reporter, reason } = await createSentryReporter(dsn, env, opts.load);
  if (reporter) {
    target.reporter = reporter;
    log.info('error_reporting', 'Sentry error reporting on');
  } else {
    target.reporter = new LogReporter(log);
    log.warn('error_reporting', `SENTRY_DSN is set but Sentry is off: ${reason}`);
  }
  return target.reporter.name;
}

/**
 * Report crashes, then exit on uncaughtException (state may be broken; the platform restarts us).
 * unhandledRejection is reported but does not exit.
 */
export function installProcessHandlers(target: Errors = errors, exit: (code: number) => void = (c) => process.exit(c)): void {
  process.on('unhandledRejection', (reason) => {
    target.capture(reason, { op: 'unhandled_rejection', level: 'error' });
  });
  process.on('uncaughtException', (err) => {
    target.capture(err, { op: 'uncaught_exception', level: 'fatal' });
    void target.flush(2000).finally(() => exit(1));
  });
}
