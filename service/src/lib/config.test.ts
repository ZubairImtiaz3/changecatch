import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONFIG_KEYS, loadConfig, REPO_ROOT, SERVICE_ROOT, type Env } from './config.js';
import { HS_PORTAL_RATE_PER_10S } from './rate-limiter.js';
import { DEFAULT_PAIRING_CONFIG } from '../core/pairing.js';
import { DEFAULT_DELAY_CONFIG } from '../worker/schedule.js';
import { DEFAULT_RETRY_WINDOW_MS } from '../worker/stamp-queue.js';

const BASE: Env = {
  HUBSPOT_CLIENT_ID: 'cid',
  HUBSPOT_CLIENT_SECRET: 'secret',
  TOKEN_ENC_KEYS: `k1:${randomBytes(32).toString('base64')}`,
};

test('config: docs/configuration.md and .env.example list exactly the variables loadConfig reads', () => {
  const docs = readFileSync(join(REPO_ROOT, 'docs', 'configuration.md'), 'utf8');
  const documented = [...docs.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1]);
  const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
  const listed = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
  const keys = [...CONFIG_KEYS].sort();
  assert.deepEqual([...new Set(documented)].sort(), keys, 'docs/configuration.md variable tables');
  assert.deepEqual([...new Set(listed)].sort(), keys, '.env.example');
});

test('config: the Default column of docs/configuration.md matches the code', () => {
  const docs = readFileSync(join(REPO_ROOT, 'docs', 'configuration.md'), 'utf8');
  const defaults = new Map([...docs.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|[^|]*\|([^|]*)\|/gm)].map((m) => [m[1], m[2].trim()]));
  const w = loadConfig('worker', BASE);
  const api = loadConfig('api', { ...BASE, HUBSPOT_REDIRECT_URI: 'http://localhost:3001/oauth/callback' });
  // Tools defaults live in the tools package (not imported by the service): read them from the source.
  const toolsSrc = (f: string) => readFileSync(join(REPO_ROOT, 'tools', 'src', 'lib', f), 'utf8');
  const testLabels = /DEFAULT_TEST_LABELS = \[([^\]]*)\]/.exec(toolsSrc('test-labels.ts'))![1].split(',').map((x) => x.trim().slice(1, -1));
  const code: Record<string, string> = {
    SETTINGS_ALLOW_UNSIGNED: api.api.allowUnsigned ? '1' : '0',
    DB_PATH: relative(SERVICE_ROOT, w.dbPath).replaceAll('\\', '/'),
    HS_PORTAL_RATE_PER_10S: String(HS_PORTAL_RATE_PER_10S),
    JOURNAL_POLL_MS: String(w.worker.journalPollMs ?? DEFAULT_DELAY_CONFIG.pollMs),
    PAIRING_WINDOW_MS: String(w.worker.pairingWindowMs ?? DEFAULT_PAIRING_CONFIG.windowMs),
    PAIRING_SPLIT_HOLD_MS: String(w.worker.pairingSplitHoldMs ?? DEFAULT_PAIRING_CONFIG.splitHoldMs),
    STAMP_MIRROR: w.worker.stampMirror ? '1' : '0',
    STAMP_RETRY_MAX_MS: String(w.worker.stampRetryMaxMs ?? DEFAULT_RETRY_WINDOW_MS),
    WORKER_HEALTH_PORT: String(w.worker.healthPort),
    LOG_LEVEL: w.log.level,
    LOG_FORMAT: w.log.format,
    CHANGECATCH_TEST_LABELS: testLabels.join(','),
    SAMPLES_DIR: /join\(TOOLS_ROOT, 'samples'\)/.test(toolsSrc('paths.ts')) ? 'tools/samples' : '(changed)',
  };
  for (const [k, cell] of defaults) {
    const literal = /^`([^`]+)`/.exec(cell)?.[1];
    if (literal === undefined) continue; // unset, (required) or a description
    assert.ok(k in code, `${k}: add its code default to this test`);
    assert.equal(literal, code[k], `${k} default`);
  }
  // (required) rows: loadConfig refuses to start without them.
  for (const [k, cell] of defaults) {
    if (cell !== '(required)') continue;
    const env = { ...BASE, HUBSPOT_REDIRECT_URI: 'http://localhost:3001/oauth/callback' };
    delete (env as Record<string, string | undefined>)[k];
    assert.throws(() => loadConfig('api', env), new RegExp(k), `${k} is documented as required`);
  }
});

test('config: only lib/config.ts (and CLI entry points) read process.env', () => {
  const allowed = new Set(['service/src/lib/config.ts', 'service/src/cli/dev.ts']);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        const rel = relative(REPO_ROOT, p).replaceAll('\\', '/');
        if (!allowed.has(rel) && readFileSync(p, 'utf8').includes('process.env')) offenders.push(rel);
      }
    }
  };
  walk(join(SERVICE_ROOT, 'src'));
  walk(join(REPO_ROOT, 'tools', 'src'));
  assert.deepEqual(offenders, []);
});

test('config: an empty value counts as unset; set values are parsed once', () => {
  const unset = loadConfig('worker', BASE);
  assert.deepEqual(loadConfig('worker', { ...BASE, LOG_LEVEL: '', JOURNAL_POLL_MS: '  ' }), unset);
  assert.equal(unset.worker.journalPollMs, undefined, 'undefined = the module default (DEFAULT_DELAY_CONFIG)');
  assert.equal(unset.dbPath, join(SERVICE_ROOT, 'data', 'changecatch.db'), 'relative DB_PATH resolves against service/');

  const d = loadConfig('worker', { ...BASE, JOURNAL_POLL_MS: '5000', PAIRING_WINDOW_MS: '1500', PAIRING_SPLIT_HOLD_MS: '0', STAMP_MIRROR: '1', LOG_LEVEL: 'DEBUG', DB_PATH: ':memory:' });
  assert.deepEqual([d.worker.journalPollMs, d.worker.pairingWindowMs, d.worker.pairingSplitHoldMs, d.worker.stampMirror], [5000, 1500, 0, true]);
  assert.equal(d.log.level, 'debug');
  assert.equal(d.dbPath, ':memory:');
});

test('config: junk or missing required values fail at start with the variable name', () => {
  assert.throws(() => loadConfig('worker', { ...BASE, JOURNAL_POLL_MS: 'abc' }), /JOURNAL_POLL_MS/);
  assert.throws(() => loadConfig('worker', { ...BASE, PAIRING_WINDOW_MS: '-1' }), /PAIRING_WINDOW_MS/);
  assert.throws(() => loadConfig('worker', { ...BASE, STAMP_MIRROR: 'true' }), /STAMP_MIRROR/);
  assert.throws(() => loadConfig('worker', { ...BASE, LOG_FORMAT: 'xml' }), /LOG_FORMAT/);
  assert.throws(() => loadConfig('worker', { ...BASE, WORKER_HEALTH_PORT: '70000' }), /WORKER_HEALTH_PORT/);
  assert.throws(() => loadConfig('worker', { ...BASE, HEARTBEAT_URL: 'not a url' }), /HEARTBEAT_URL/);
  assert.throws(() => loadConfig('worker', { ...BASE, HUBSPOT_CLIENT_ID: '' }), /Missing env var HUBSPOT_CLIENT_ID/);
  assert.throws(() => loadConfig('worker', { ...BASE, TOKEN_ENC_KEYS: undefined }), /TOKEN_ENC_KEYS/);
  assert.throws(() => loadConfig('worker', { ...BASE, TOKEN_ENC_KEYS: 'k1:short' }), /32 bytes/);
});

test('config: the API server needs HUBSPOT_REDIRECT_URI; PORT defaults to its port; production rules (security review H1)', () => {
  assert.throws(() => loadConfig('api', BASE), /Missing env var HUBSPOT_REDIRECT_URI/);
  assert.equal('api' in loadConfig('worker', BASE), false, 'only the API server parses its section');
  const api = { ...BASE, HUBSPOT_REDIRECT_URI: 'http://localhost:4567/oauth/callback' };
  const c = loadConfig('api', api);
  assert.equal(c.api.port, 4567);
  assert.equal(c.api.redirectUri.pathname, '/oauth/callback');
  assert.equal(c.api.allowUnsigned, false);
  assert.equal(loadConfig('api', { ...api, PORT: '8080', HUBSPOT_APP_ID: '42' }).api.port, 8080);
  assert.equal(loadConfig('api', { ...api, HUBSPOT_APP_ID: '42' }).api.appId, 42);
  assert.throws(() => loadConfig('api', { ...api, HUBSPOT_APP_ID: 'abc' }), /HUBSPOT_APP_ID/);
  assert.throws(() => loadConfig('api', { ...api, PUBLIC_BASE_URL: 'https://x.example.com/path' }), /PUBLIC_BASE_URL/);
  assert.throws(() => loadConfig('api', { ...api, NODE_ENV: 'production' }), /PUBLIC_BASE_URL is required/);
  assert.throws(() => loadConfig('api', { ...api, NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://x.example.com' }), /https/);
  assert.equal(loadConfig('api', { ...api, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://x.example.com' }).production, true);
});

test('config: SETTINGS_ALLOW_UNSIGNED is refused in production and with a public URL', () => {
  const api = { ...BASE, HUBSPOT_REDIRECT_URI: 'http://localhost:4567/oauth/callback', SETTINGS_ALLOW_UNSIGNED: '1' };
  assert.throws(() => loadConfig('api', { ...api, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://x.example.com' }), /NODE_ENV=production/);
  assert.throws(() => loadConfig('api', { ...api, PUBLIC_BASE_URL: 'https://abc.example.com' }), /localhost/);
  assert.equal(loadConfig('api', { ...api, PUBLIC_BASE_URL: 'http://127.0.0.1:3001' }).api.allowUnsigned, true);
  assert.equal(loadConfig('api', api).api.allowUnsigned, true, 'PUBLIC_BASE_URL unset');
  assert.equal(loadConfig('api', { ...BASE, HUBSPOT_REDIRECT_URI: 'http://x/cb', NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://x.example.com' }).api.allowUnsigned, false);
});

test('config: every constant in the docs/configuration.md "Fixed values" table exists in the file it names', () => {
  const docs = readFileSync(join(REPO_ROOT, 'docs', 'configuration.md'), 'utf8');
  const rows = docs.slice(docs.indexOf('## Fixed values')).split(/\r?\n/).filter((r) => r.startsWith('| ') && r.includes('.ts`'));
  assert.ok(rows.length > 10);
  for (const row of rows) {
    const last = row.split('|').at(-2)!;
    const ticks = [...last.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const files = ticks.filter((t) => t.endsWith('.ts'));
    const src = files.map((f) => readFileSync(join(SERVICE_ROOT, 'src', f), 'utf8')).join('\n');
    for (const name of ticks.filter((t) => !t.endsWith('.ts'))) assert.ok(new RegExp(String.raw`\b${name}\b`).test(src),`${name} in ${files.join(', ')}`);
  }
});
