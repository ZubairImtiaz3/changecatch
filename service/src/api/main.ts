// ChangeCatch app server: multi-portal OAuth install + settings API. See docs/architecture.md.
// Usage: pnpm --filter @changecatch/service start:api  (or: npx tsx src/api/main.ts) [--no-lifecycle]
//   --no-lifecycle skips the periodic check of the 2 app-level APP_LIFECYCLE_EVENT journal subscriptions.
// It is the ONLY process that provisions portals (Installer.provisionPending, on start and every PROVISION_SWEEP_MS).
// The app server exposes no metrics endpoint (docs/observability.md).

import { loadConfig, type ApiConfig, type Config } from '../lib/config.js';
import { journalClient } from '../hubspot/journal.js';
import { exchangeCode, refreshAccessToken } from '../hubspot/oauth.js';
import { installPath } from '../install/http-util.js';
import { PortalStore } from '../store/portals.js';
import { PortalTokenProvider } from '../hubspot/portal-tokens.js';
import { createLabelOptionSync } from '../hubspot/properties.js';
import { Installer, PROVISION_SWEEP_MS } from '../install/installer.js';
import { createAppServer } from '../install/server.js';
import { startLifecycleSubscriptionWatch } from '../hubspot/app-lifecycle.js';
import { startProcess } from '../lib/process.js';
import { createLogger } from '../obs/log.js';

const log = createLogger('app');

function fatal(msg: string, e?: unknown): void {
  log.error('fatal', `FATAL: ${msg}`, e === undefined ? {} : { error: e });
  process.exit(1);
}

function main(config: Config & { api: ApiConfig }): void {
  const { api } = config;
  const redirect = api.redirectUri;
  const { port, publicBaseUrl, appId, allowUnsigned } = api;
  const oauthApp = { ...config.hubspot, redirectUri: redirect.toString() };
  const journal = journalClient(config.hubspot);

  const portals = new PortalStore({ path: config.dbPath, key: config.tokenKey });
  const tokens = new PortalTokenProvider({
    store: portals,
    refresh: (rt) => refreshAccessToken(config.hubspot, rt),
    logger: log.child({ component: 'oauth' }),
  });
  const installer = new Installer({
    portals,
    tokens,
    subscriptions: journal,
    syncOptions: createLabelOptionSync(),
    log: log.child({ component: 'install' }),
  });

  const server = createAppServer({
    installer,
    portals,
    oauthApp,
    exchangeCode: (code) => exchangeCode(oauthApp, code),
    clientSecret: config.hubspot.clientSecret,
    callbackPath: redirect.pathname,
    appId,
    publicBaseUrl,
    allowUnsigned,
    log,
  });

  server.listen(port, async () => {
    log.info('app_started', `ChangeCatch app server on http://localhost:${port}`, {
      port,
      install: `http://localhost:${port}${installPath(1)}`,
      callback: redirect.toString(),
      settings: `${publicBaseUrl ?? '(PUBLIC_BASE_URL not set: settings page signatures will fail)'}/api/settings`,
      customConsent: `http://localhost:${port}${installPath(2)}`,
      installedPortals: portals.listInstalled().map((p) => p.portalId),
    });
    if (!appId) log.warn('no_app_id', 'HUBSPOT_APP_ID is not set: after install, users see a plain "installed" page instead of being sent to the ChangeCatch settings in HubSpot.');
    if (allowUnsigned) log.warn('unsigned_settings', 'SETTINGS_ALLOW_UNSIGNED=1, signature checks are OFF. Local testing only.');
    void installer.provisionPending();
    setInterval(() => void installer.provisionPending(), PROVISION_SWEEP_MS).unref();
    if (!process.argv.includes('--no-lifecycle')) {
      startLifecycleSubscriptionWatch({ api: journal, log: log.child({ component: 'lifecycle-subs' }) });
    }
  });

  // Graceful stop: close the listener, then exit.
  let stopping = false;
  const onSignal = (sig: string) => {
    if (stopping) process.exit(130);
    stopping = true;
    log.info('shutdown', `${sig}: stopping the app server`);
    const done = () => process.exit(0);
    server.close(done);
    setTimeout(done, 5000).unref();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

// All config is read here: a missing or bad variable exits with one FATAL line, no stack trace.
async function start(): Promise<void> {
  const config = loadConfig('api');
  startProcess(config, { log });
  main(config);
}

void start().catch((e) => fatal(e instanceof Error ? e.message : String(e), e));
