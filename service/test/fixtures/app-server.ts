// Test fixture: an app server with harmless defaults (unused installer / code exchange, empty in-memory store).
// Each test passes only the options it is about.

import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { memoryLogger } from './log.js';
import { PortalStore } from '../../src/store/portals.js';
import { createAppServer, type AppServerOptions } from '../../src/install/server.js';
import { parseKeyring } from '../../src/lib/crypto.js';

const unused = async (): Promise<never> => { throw new Error('unused'); };

type Installer = AppServerOptions['installer'];

/** `installer` may be partial: missing methods are unused (objectTypes: one Deal type). */
export function testAppServer(o: Partial<Omit<AppServerOptions, 'installer'>> & { installer?: Partial<Installer> } = {}) {
  const { installer: i = {}, ...rest } = o;
  return createAppServer({
    installer: {
      completeInstall: (t) => (i.completeInstall ? i.completeInstall(t) : unused()),
      saveSettings: (p, input) => (i.saveSettings ? i.saveSettings(p, input) : unused()),
      objectTypes: (p) => (i.objectTypes ? i.objectTypes(p) : Promise.resolve([{ objectTypeId: '0-3', singular: 'Deal', plural: 'Deals', custom: false }])),
    },
    portals: new PortalStore({ path: ':memory:', key: parseKeyring(`t:${randomBytes(32).toString('base64')}`) }),
    oauthApp: { clientId: 'cid', redirectUri: 'http://localhost:3001/oauth/callback' },
    exchangeCode: unused,
    clientSecret: 's',
    callbackPath: '/oauth/callback',
    log: memoryLogger().log,
    errors: { capture: () => true },
    ...rest,
  });
}

/** Listen on a free port; returns the base URL. Explicit IPv4 on both sides: "localhost" can resolve to ::1 or
 * 127.0.0.1 (Windows), and a mismatch made tests flaky. */
export async function listen(server: ReturnType<typeof createAppServer>): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
