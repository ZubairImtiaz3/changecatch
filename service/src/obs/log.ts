// Structured JSON logger: one JSON object per line on stdout (info/debug) or stderr (warn/error).
// Shape: { level, ts, component, portalId?, event?, msg, ...fields }
// Everything goes through redact() first, so tokens never reach the log.
//
// Usage:
//   const log = createLogger('worker');   // a process's root logger; children inherit its options
//   log.info('journal_read', 'read 3 files', { files: 3, offset });
//   log.child({ portalId: 123 }).warn('stamp_retry', 'retry in 30s', { attempts: 2 });
//   log.alert('worker_stale', 'no successful journal read for 1 h');
//
// Alerts: log.alert(name, msg) writes ONE line { level: "error", event: "alert", alert: name }. log.alertCleared(name,
// msg) writes { level: "info", event: "alert_cleared", alert: name }. Search logs by event=alert, then alert=<name>
// (docs/observability.md). Callers throttle repeated alerts themselves (obs/alerts.ts AlertThrottle).
// Every alert name is in ALERTS (below); docs/runbook.md lists exactly these (obs.test.ts).
//
// Level and format: each entry point calls configureLogging(config.log) once (LOG_LEVEL / LOG_FORMAT, lib/config.ts).

/** Every alert name log.alert accepts. docs/runbook.md "Log strings to know" lists exactly these (obs.test.ts). */
export const ALERTS = [
  'worker_stale',
  'offset_expired',
  'journal_entries_skipped',
  'journal_file_rejected',
  'stamps_refused',
  'portal_paused',
  'pause_expired',
  'uninstall_retry_failing',
  'provisioning_failing',
  'parked_entries_dropped',
  'worker_lock_lost',
  'worker_lock_refused',
] as const;
export type AlertName = (typeof ALERTS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LOG_FORMATS = ['json', 'pretty'] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  level: LogLevel;
  ts: string;
  component: string;
  portalId?: number;
  /** Short machine-readable name, snake_case (e.g. "journal_read", "stamp_sent"). Good for log queries. */
  event?: string;
  msg: string;
  [field: string]: unknown;
}

export type LogSink = (rec: LogRecord, line: string) => void;

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  sink?: LogSink;
  now?: () => number;
}

// ---------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------

export const REDACTED = '[REDACTED]';

/** Object keys whose value is always hidden, whatever it looks like. Compared lower-case, without _ and -. */
const SECRET_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'secret',
  'password',
  'passwd',
  'authorization',
  'auth',
  'cookie',
  'setcookie',
  'apikey',
  'hapikey',
  'privatekey',
  'encryptionkey',
  'tokenencryptionkey',
  'code', // OAuth authorization code
  'dsn',
  'signature',
  'xhubspotsignature',
  'xhubspotsignaturev3',
]);

const normKey = (k: string) => k.toLowerCase().replace(/[_-]/g, '');

function isSecretKey(key: string): boolean {
  const k = normKey(key);
  if (SECRET_KEYS.has(k)) return true;
  // e.g. HUBSPOT_CLIENT_SECRET, changecatchRefreshToken, x-api-key
  return /(secret|token|password|apikey|privatekey)$/.test(k);
}

/** String patterns that look like credentials. Order matters: specific ones first. */
const STRING_PATTERNS: { re: RegExp; replace: string | ((m: string, ...g: string[]) => string) }[] = [
  // Authorization: Bearer xxx / Basic xxx
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, replace: (_m, scheme) => `${scheme} ${REDACTED}` },
  // Signed URLs (journal file downloads): the whole query string is the credential.
  { re: /(\bhttps?:\/\/[^\s?"']+)\?[^\s"']*(?:X-Amz-|\bsig=|\bsignature=)[^\s"']*/gi, replace: (_m, base) => `${base}?${REDACTED}` },
  // key=value in URLs, form bodies, or messages
  {
    re: /\b(access_token|refresh_token|id_token|client_secret|hapikey|api_key|apikey|code|state|token|password|signature|X-Amz-Signature|X-Amz-Credential|sig)=([^&\s"']+)/gi,
    replace: (_m, k) => `${k}=${REDACTED}`,
  },
  // "refresh_token": "..." inside JSON text that was logged as a string
  {
    re: /("(?:access_token|refresh_token|id_token|client_secret|code|state|token|password|signature)"\s*:\s*")[^"]*"/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED}"`,
  },
  // HubSpot private app / service keys / personal access keys: pat-na1-xxxxxxxx-xxxx-...
  { re: /\bpat-[a-z]{2,3}\d?-[A-Za-z0-9-]{8,}/g, replace: REDACTED },
  // HubSpot OAuth refresh tokens look like: na1-1a2b-3c4d-... (region prefix + uuid-ish)
  { re: /\b(?:na|eu|ap)\d-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f-]{8,}\b/gi, replace: REDACTED },
  // JWTs
  { re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, replace: REDACTED },
  // Any URL with user:pass@ credentials (DSNs, connection strings)
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, replace: (_m, scheme) => `${scheme}${REDACTED}@` },
  // Long hex secrets (32+ hex chars, no dashes; UUIDs and journal offsets have dashes, so they survive)
  { re: /\b[0-9a-f]{32,}\b/gi, replace: REDACTED },
];

/** Long base64/base64url run with letters AND digits: HubSpot access tokens (CJ...), encryption keys, etc. */
const LONG_B64 = /[A-Za-z0-9+_-]{40,}={0,2}/g;

export function redactString(s: string): string {
  let out = s;
  for (const p of STRING_PATTERNS) out = out.replace(p.re, p.replace as any);
  out = out.replace(LONG_B64, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) && !m.startsWith('[REDACTED') ? REDACTED : m));
  return out;
}

/** Deep copy with secrets removed. Safe on cycles, Errors, Maps, Sets, bigint, Dates. */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth > 8) return '[depth]';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);
  if (value instanceof Error) {
    const e = value as Error & { status?: unknown; code?: unknown; cause?: unknown };
    const out: Record<string, unknown> = { name: e.name, message: redactString(e.message) };
    if (e.status !== undefined) out.status = e.status;
    if (e.code !== undefined) out.code = redact(e.code, depth + 1, seen);
    if (e.stack) out.stack = redactString(e.stack.split('\n').slice(0, 8).join('\n'));
    if (e.cause !== undefined) out.cause = redact(e.cause, depth + 1, seen);
    return out;
  }
  if (Array.isArray(value)) {
    const arr = value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
    if (value.length > 50) arr.push(`[+${value.length - 50} more]`);
    return arr;
  }
  if (value instanceof Map) return redact(Object.fromEntries(value), depth + 1, seen);
  if (value instanceof Set) return redact([...value], depth + 1, seen);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // `code` is an OAuth auth code in the install flow, but an error code (ECONNRESET, 429) elsewhere: keep those.
    const harmlessCode = normKey(k) === 'code' && (typeof v === 'number' || (typeof v === 'string' && /^[A-Z0-9_]{1,40}$/.test(v)));
    out[k] = isSecretKey(k) && !harmlessCode && v !== null && v !== undefined && v !== '' ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------------------------

/** Process-wide level and format for loggers without their own; read at log time, so module-level loggers follow. */
let processDefaults: { level: LogLevel; format: LogFormat } = { level: 'info', format: 'json' };

/** Called once by each entry point with config.log. */
export function configureLogging(o: { level: LogLevel; format: LogFormat }): void {
  processDefaults = { ...o };
}

const defaultSink: LogSink = (rec, line) => {
  if (rec.level === 'warn' || rec.level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

function formatPretty(r: LogRecord): string {
  const { level, ts, component, portalId, event, msg, ...rest } = r;
  const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
  return `${ts} ${level.toUpperCase().padEnd(5)} [${component}]${portalId !== undefined ? ` p${portalId}` : ''}${event ? ` ${event}` : ''} ${msg}${extra}`;
}

/** Fields that the logger owns; callers cannot overwrite them through `fields`. */
const RESERVED = new Set(['level', 'ts', 'component', 'msg']);

export class Logger {
  private readonly sink: LogSink;
  private readonly now: () => number;

  constructor(
    readonly component: string,
    private readonly base: { portalId?: number; [k: string]: unknown } = {},
    private readonly opts: LoggerOptions = {},
  ) {
    this.sink = opts.sink ?? defaultSink;
    this.now = opts.now ?? Date.now;
  }

  /** Same logger with extra fixed fields (e.g. { portalId }). */
  child(fields: { portalId?: number; component?: string; [k: string]: unknown }): Logger {
    const { component, ...rest } = fields;
    return new Logger(component ?? this.component, { ...this.base, ...rest }, this.opts);
  }

  enabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.opts.level ?? processDefaults.level];
  }

  log(level: LogLevel, event: string | undefined, msg: string, fields: Record<string, unknown> = {}): void {
    if (!this.enabled(level)) return;
    const merged = redact({ ...this.base, ...fields }) as Record<string, unknown>;
    // No CR/LF inside a message: one record = one line, also in the pretty format (log injection).
    const rec: LogRecord = { level, ts: new Date(this.now()).toISOString(), component: this.component, msg: redactString(msg).replace(/[\r\n]+/g, ' ') };
    if (merged.portalId !== undefined) rec.portalId = merged.portalId as number;
    if (event) rec.event = event;
    for (const [k, v] of Object.entries(merged)) {
      if (k === 'portalId' || k === 'event' || RESERVED.has(k) || v === undefined) continue;
      rec[k] = v;
    }
    let line: string;
    try {
      line = (this.opts.format ?? processDefaults.format) === 'pretty' ? formatPretty(rec) : JSON.stringify(rec);
    } catch {
      line = JSON.stringify({ level, ts: rec.ts, component: this.component, msg: rec.msg, logError: 'fields not serialisable' });
    }
    try {
      this.sink(rec, line);
    } catch {
      /* logging must never throw */
    }
  }

  debug(event: string, msg: string, fields?: Record<string, unknown>): void {
    this.log('debug', event, msg, fields);
  }
  info(event: string, msg: string, fields?: Record<string, unknown>): void {
    this.log('info', event, msg, fields);
  }
  warn(event: string, msg: string, fields?: Record<string, unknown>): void {
    this.log('warn', event, msg, fields);
  }
  error(event: string, msg: string, fields?: Record<string, unknown>): void {
    this.log('error', event, msg, fields);
  }

  /** Something a human must act on: one line, level error, event "alert", field alert = `name`. */
  alert(name: AlertName, msg: string, fields: Record<string, unknown> = {}): void {
    this.log('error', 'alert', msg, { ...fields, alert: name });
  }

  /** The condition behind alert `name` is gone: level info, event "alert_cleared". */
  alertCleared(name: AlertName, msg: string, fields: Record<string, unknown> = {}): void {
    this.log('info', 'alert_cleared', msg, { ...fields, alert: name });
  }
}

export function createLogger(component: string, opts?: LoggerOptions): Logger {
  return new Logger(component, {}, opts);
}
