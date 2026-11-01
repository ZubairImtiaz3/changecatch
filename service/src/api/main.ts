// ChangeCatch app server: multi-portal OAuth install + settings API. See docs/architecture.md.
// Usage: pnpm --filter @changecatch/service start:api  (or: npx tsx src/api/main.ts) [--no-lifecycle]
//   Listens on PORT, else the port of HUBSPOT_REDIRECT_URI (e.g. 3001). Install URL: http://localhost:<port>/install
//   The OAuth callback path is the path of HUBSPOT_REDIRECT_URI.
//   On start, and then every LIFECYCLE_SUB_CHECK_MS (default 10 min), it makes sure the 2 app-level
//   APP_LIFECYCLE_EVENT journal subscriptions exist and recreates any that are missing (idempotent);
//   --no-lifecycle skips that.
// Env: HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, HUBSPOT_REDIRECT_URI, TOKEN_ENC_KEYS (or legacy TOKEN_ENC_KEY),
//      PORT, CUSTOM_WRITE_MODE, PUBLIC_BASE_URL (needed for settings-page signatures; required when NODE_ENV=production),
//      DB_PATH (optional), CHANGECATCH_DEFAULT_PAIRS (optional),
//      SETTINGS_ALLOW_UNSIGNED=1 (local testing only; refused with NODE_ENV=production or a non-localhost PUBLIC_BASE_URL).
//      Monitoring: LOG_LEVEL, LOG_FORMAT (JSON logs, secrets redacted), SENTRY_* (optional error reporting).
//      `[ALERT]` lines and error-level lines go to the error reporter. See docs/observability.md.

import { env, optionalEnv } from '../lib/env.js';
import { buildInstallUrl, exchangeCode } from '../hubspot/oauth.js';
import { PortalStore } from '../store/portals.js';
import { PortalTokenProvider } from '../install/token-provider.js';
import { Installer } from '../install/installer.js';
import { listObjectTypes } from '../install/object-types.js';
import { assertUnsignedAllowed, createAppServer } from '../install/server.js';
import { startLifecycleSubscriptionWatch } from '../install/subscriptions.js';
import { defaultPairs } from '../install/pairs.js';
import { customWriteMode } from '../install/scopes.js';
import { createLogger } from '../obs/log.js';
import { errors, initErrorReporting, installProcessHandlers } from '../obs/errors.js';
import { classifiedLog } from '../obs/wiring.js';

const log = createLogger('app');

function fatal(msg: string, e?: unknown): never {
  log.error('fatal', `FATAL: ${msg}`);
  if (e !== undefined) errors.capture(e, { component: 'app', op: 'startup', level: 'fatal' });
  void errors.flush(2000).finally(() => process.exit(1));
  // Keep TypeScript happy; process.exit runs after the flush.
  throw new ExitPending();
}
class ExitPending extends Error {}

// All config is read inside main(): a missing or bad env var exits with one FATAL line, no stack trace.
function main(): void {
  const redirect = new URL(env('HUBSPOT_REDIRECT_URI'));
  const port = Number(process.env.PORT || redirect.port || 3000);
  const publicBaseUrl = optionalEnv('PUBLIC_BASE_URL');
  const allowUnsigned = optionalEnv('SETTINGS_ALLOW_UNSIGNED') === '1';
  const production = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';

  // Fail fast on unsafe config (security review H1): exit with a clear error, never start half-protected.
  try {
    assertUnsignedAllowed({ allowUnsigned, nodeEnv: process.env.NODE_ENV, publicBaseUrl });
    if (production && !publicBaseUrl) throw new Error('PUBLIC_BASE_URL is required when NODE_ENV=production (settings signatures cover the public URL).');
    if (publicBaseUrl && !/^https?:\/\/[^/?#]+\/?$/.test(publicBaseUrl)) throw new Error('PUBLIC_BASE_URL must be an origin like https://changecatch.example.com (no path or query).');
    if (production && publicBaseUrl && !publicBaseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must use https:// when NODE_ENV=production.');
  } catch (e) {
    fatal((e as Error).message);
  }

  defaultPairs(); // fail fast on a bad CHANGECATCH_DEFAULT_PAIRS
  const mode = customWriteMode(); // fail fast on a bad CUSTOM_WRITE_MODE (conditional | optional)
  const portals = new PortalStore();
  const tokens = new PortalTokenProvider({ store: portals, logger: log.child({ component: 'oauth' }) });
  const installer = new Installer({ portals, tokens, log: classifiedLog(log.child({ component: 'install' }), { fallbackEvent: 'install' }) });

  const server = createAppServer({
    installer,
    portals,
    objectTypes: async (portalId) => listObjectTypes(await tokens.getAccessToken(portalId)),
    buildInstallUrl: (state, o) => buildInstallUrl(state, { ...o, mode }),
    customWriteMode: mode,
    exchangeCode,
    clientSecret: env('HUBSPOT_CLIENT_SECRET'),
    callbackPath: redirect.pathname,
    publicBaseUrl,
    allowUnsigned,
    log: classifiedLog(log, { fallbackEvent: 'app' }),
  });

  server.listen(port, async () => {
    log.info('app_started', `ChangeCatch app server on http://localhost:${port}`, {
      port,
      install: `http://localhost:${port}/install`,
      callback: redirect.toString(),
      settings: `${publicBaseUrl ?? '(PUBLIC_BASE_URL not set: settings page signatures will fail)'}/api/settings`,
      customWriteMode: mode,
      customConsent: `http://localhost:${port}/install?custom=1`,
      installedPortals: portals.listInstalled().map((p) => p.portalId),
    });
    if (allowUnsigned) log.warn('unsigned_settings', 'SETTINGS_ALLOW_UNSIGNED=1, signature checks are OFF. Local testing only.');
    if (!process.argv.includes('--no-lifecycle')) {
      startLifecycleSubscriptionWatch({ log: classifiedLog(log.child({ component: 'lifecycle-subs' }), { fallbackEvent: 'lifecycle_subscriptions' }) });
    }
  });

  // Graceful stop: close the listener, then send any queued error reports before exiting.
  let stopping = false;
  const onSignal = (sig: string) => {
    if (stopping) process.exit(130);
    stopping = true;
    log.info('shutdown', `${sig}: stopping the app server`);
    const done = () => void errors.flush(2000).finally(() => process.exit(0));
    server.close(done);
    setTimeout(done, 5000).unref();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

async function start(): Promise<void> {
  await initErrorReporting({ log: log.child({ component: 'errors' }) });
  installProcessHandlers();
  try {
    main();
  } catch (e) {
    if (e instanceof ExitPending) return;
    fatal(e instanceof Error ? e.message : String(e), e);
  }
}

void start().catch((e) => {
  if (!(e instanceof ExitPending)) fatal(e instanceof Error ? e.message : String(e), e);
});
