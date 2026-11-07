// The only module that reads environment variables. Each entry point (api/main.ts, worker/main.ts, cli/*, the tools)
// calls loadConfig() once and passes the values down. Reference for every variable: docs/configuration.md.
//
// One rule for every variable: unset or empty = the default; anything else must parse, or loadConfig throws one clear
// error at start. Tuning values that never vary are named constants in their modules, not variables.
// One default convention: a tuning value is undefined when unset and the module that owns it applies its default;
// loadConfig only checks the range.

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKeyring, type Keyring } from './crypto.js';
import { LOG_FORMATS, LOG_LEVELS, type LogFormat, type LogLevel } from '../obs/log.js';

export type Env = Readonly<Record<string, string | undefined>>;

/** changecatch/service */
export const SERVICE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** changecatch (repo root) */
export const REPO_ROOT = resolve(SERVICE_ROOT, '..');

/**
 * Load .env files into process.env and return it. Files, first one wins per variable (variables already set in the
 * shell are never overwritten): ./.env (current dir), service/.env, <repo>/.env (the normal place).
 */
function loadEnvFiles(): Env {
  for (const f of new Set([resolve('.env'), join(SERVICE_ROOT, '.env'), join(REPO_ROOT, '.env')])) {
    if (existsSync(f)) process.loadEnvFile(f);
  }
  return process.env;
}

export interface ApiConfig {
  /** HUBSPOT_REDIRECT_URI: its path is the OAuth callback route. */
  redirectUri: URL;
  port: number;
  publicBaseUrl: string | undefined;
  appId: number | undefined;
  allowUnsigned: boolean;
}

/**
 * undefined = the owning module's default (worker/schedule.ts DEFAULT_DELAY_CONFIG, core/pairing.ts
 * DEFAULT_PAIRING_CONFIG, worker/stamp-queue.ts DEFAULT_RETRY_WINDOW_MS).
 */
export interface WorkerConfig {
  journalPollMs: number | undefined;
  pairingWindowMs: number | undefined;
  pairingSplitHoldMs: number | undefined;
  stampMirror: boolean;
  stampRetryMaxMs: number | undefined;
  healthPort: number;
  healthToken: string | undefined;
  heartbeatUrl: string | undefined;
}

export interface ToolsConfig {
  testPortalId: number | undefined;
  setupToken: string | undefined;
  testLabels: string[] | undefined;
  samplesDir: string | undefined;
}

export interface Config {
  production: boolean;
  /** The app's OAuth client (HubSpot developer project). */
  hubspot: { clientId: string; clientSecret: string };
  /** Refresh-token encryption keys (TOKEN_ENC_KEYS; lib/crypto.ts). */
  tokenKey: Keyring;
  /** Absolute path of the SQLite file shared by the API server, the worker and the tools. */
  dbPath: string;
  /** undefined = lib/rate-limiter.ts HS_PORTAL_RATE_PER_10S. */
  portalRatePer10s: number | undefined;
  log: { level: LogLevel; format: LogFormat };
  worker: WorkerConfig;
  tools: ToolsConfig;
}

export type Process = 'api' | 'worker' | 'tool';

/** Every variable loadConfig reads. docs/configuration.md and .env.example document exactly these (config.test.ts). */
export const CONFIG_KEYS = [
  'NODE_ENV',
  'HUBSPOT_CLIENT_ID',
  'HUBSPOT_CLIENT_SECRET',
  'TOKEN_ENC_KEYS',
  'DB_PATH',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'HUBSPOT_REDIRECT_URI',
  'PORT',
  'PUBLIC_BASE_URL',
  'HUBSPOT_APP_ID',
  'SETTINGS_ALLOW_UNSIGNED',
  'HS_PORTAL_RATE_PER_10S',
  'JOURNAL_POLL_MS',
  'PAIRING_WINDOW_MS',
  'PAIRING_SPLIT_HOLD_MS',
  'STAMP_MIRROR',
  'STAMP_RETRY_MAX_MS',
  'WORKER_HEALTH_PORT',
  'HEALTH_TOKEN',
  'HEARTBEAT_URL',
  'HUBSPOT_TEST_PORTAL_ID',
  'HUBSPOT_SETUP_TOKEN',
  'CHANGECATCH_TEST_LABELS',
  'SAMPLES_DIR',
] as const;
type Key = (typeof CONFIG_KEYS)[number];

/** A relative DB_PATH is relative to service/ (not the current dir), so every process opens the same file. */
function resolveDbPath(p: string): string {
  if (p === ':memory:' || p.startsWith('file:') || isAbsolute(p)) return p;
  return resolve(SERVICE_ROOT, p);
}

function parser(env: Env) {
  const raw = (k: Key): string | undefined => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };
  const bad = (k: Key, want: string): never => {
    throw new Error(`Invalid ${k}="${env[k]}": expected ${want}. See docs/configuration.md.`);
  };
  const missing = (k: Key): never => {
    throw new Error(`Missing env var ${k}. See .env.example.`);
  };
  const required = (k: Key): string => raw(k) ?? missing(k);
  const optInt = (k: Key, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined => {
    const v = raw(k);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : bad(k, max === Number.MAX_SAFE_INTEGER ? `a whole number >= ${min}` : `a whole number from ${min} to ${max}`);
  };
  const int = (k: Key, dflt: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => optInt(k, min, max) ?? dflt;
  const flag = (k: Key): boolean => {
    const v = raw(k);
    return v === undefined || v === '0' ? false : v === '1' ? true : bad(k, '1 or 0');
  };
  const oneOf = <T extends string>(k: Key, values: readonly T[], dflt: T): T => {
    const v = raw(k)?.toLowerCase();
    if (v === undefined) return dflt;
    return (values as readonly string[]).includes(v) ? (v as T) : bad(k, values.join(' | '));
  };
  const url = (k: Key): URL | undefined => {
    const v = raw(k);
    if (v === undefined) return undefined;
    try {
      return new URL(v);
    } catch {
      return bad(k, 'a URL');
    }
  };
  return { raw, bad, missing, required, optInt, int, flag, oneOf, url };
}

const PORT_MAX = 65_535;

function apiConfig(p: ReturnType<typeof parser>, production: boolean): ApiConfig {
  const redirectUri = p.url('HUBSPOT_REDIRECT_URI') ?? p.missing('HUBSPOT_REDIRECT_URI');
  const publicBaseUrl = p.raw('PUBLIC_BASE_URL');
  // Security review H1: never start half-protected (settings signatures cover the public URL).
  if (production && !publicBaseUrl) throw new Error('PUBLIC_BASE_URL is required when NODE_ENV=production (settings signatures cover the public URL).');
  if (publicBaseUrl && !/^https?:\/\/[^/?#]+\/?$/.test(publicBaseUrl)) p.bad('PUBLIC_BASE_URL', 'an origin like https://changecatch.example.com (no path or query)');
  if (production && publicBaseUrl && !publicBaseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must use https:// when NODE_ENV=production.');
  return {
    redirectUri,
    port: p.int('PORT', Number(redirectUri.port) || 3000, 1, PORT_MAX),
    publicBaseUrl,
    appId: p.optInt('HUBSPOT_APP_ID', 1),
    allowUnsigned: unsignedAllowed(p.flag('SETTINGS_ALLOW_UNSIGNED'), production, publicBaseUrl),
  };
}

// ---- SETTINGS_ALLOW_UNSIGNED guard (owner: install/settings-api.ts, which skips signature checks when it is set)

function isLocalhostUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Unsigned settings calls only for local testing: never with NODE_ENV=production or a public PUBLIC_BASE_URL. */
function unsignedAllowed(flag: boolean, production: boolean, publicBaseUrl: string | undefined): boolean {
  if (!flag) return false;
  if (production) throw new Error('SETTINGS_ALLOW_UNSIGNED=1 is not allowed when NODE_ENV=production. Remove it.');
  // PUBLIC_BASE_URL unset (allowed outside production) = nothing public is configured.
  if (publicBaseUrl && !isLocalhostUrl(publicBaseUrl)) {
    throw new Error('SETTINGS_ALLOW_UNSIGNED=1 is only allowed when PUBLIC_BASE_URL is localhost (got a public URL). Remove it.');
  }
  return true;
}

/**
 * Parse and check the environment once. `proc` decides only which extra variables are required: the API server also
 * needs HUBSPOT_REDIRECT_URI and gets `api`. Throws one clear error on a missing required value or a bad value.
 */
export function loadConfig(proc: 'api', env?: Env): Readonly<Config & { api: ApiConfig }>;
export function loadConfig(proc: Exclude<Process, 'api'>, env?: Env): Readonly<Config>;
export function loadConfig(proc: Process, env: Env = loadEnvFiles()): Readonly<Config & { api?: ApiConfig }> {
  const p = parser(env);
  const nodeEnv = p.raw('NODE_ENV');
  const production = nodeEnv?.toLowerCase() === 'production';
  const clientId = p.required('HUBSPOT_CLIENT_ID');
  const clientSecret = p.required('HUBSPOT_CLIENT_SECRET');
  const tokenKey = parseKeyring(p.raw('TOKEN_ENC_KEYS'));
  const testLabels = p.raw('CHANGECATCH_TEST_LABELS')?.split(',').map((s) => s.trim()).filter(Boolean);
  const samplesDir = p.raw('SAMPLES_DIR');
  const config = {
    production,
    hubspot: Object.freeze({ clientId, clientSecret }),
    tokenKey,
    dbPath: resolveDbPath(p.raw('DB_PATH') ?? 'data/changecatch.db'),
    // Incident lever: lower it when a portal runs near HubSpot's 110 per 10 s account limit.
    portalRatePer10s: p.optInt('HS_PORTAL_RATE_PER_10S', 1, 110),
    log: Object.freeze({
      level: p.oneOf<LogLevel>('LOG_LEVEL', LOG_LEVELS, 'info'),
      format: p.oneOf<LogFormat>('LOG_FORMAT', LOG_FORMATS, 'json'),
    }),
    worker: Object.freeze({
      journalPollMs: p.optInt('JOURNAL_POLL_MS', 1),
      pairingWindowMs: p.optInt('PAIRING_WINDOW_MS'),
      pairingSplitHoldMs: p.optInt('PAIRING_SPLIT_HOLD_MS'),
      stampMirror: p.flag('STAMP_MIRROR'),
      // Incident lever: keep retrying failing stamps longer during a long HubSpot outage (1 h to 7 days).
      stampRetryMaxMs: p.optInt('STAMP_RETRY_MAX_MS', 3_600_000, 7 * 86_400_000),
      healthPort: p.int('WORKER_HEALTH_PORT', 3002, 1, PORT_MAX),
      healthToken: p.raw('HEALTH_TOKEN'),
      heartbeatUrl: p.url('HEARTBEAT_URL')?.toString(),
    }),
    tools: Object.freeze({
      testPortalId: p.optInt('HUBSPOT_TEST_PORTAL_ID', 1),
      setupToken: p.raw('HUBSPOT_SETUP_TOKEN'),
      testLabels: testLabels?.length ? testLabels : undefined,
      samplesDir: samplesDir === undefined ? undefined : resolve(REPO_ROOT, samplesDir),
    }),
    ...(proc === 'api' ? { api: Object.freeze(apiConfig(p, production)) } : {}),
  };
  return Object.freeze(config);
}
