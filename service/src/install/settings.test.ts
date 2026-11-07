import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PortalStore } from '../store/portals.js';
import { listen, testAppServer } from '../../test/fixtures/app-server.js';
import { parseKeyring } from '../lib/crypto.js';

const P = 111;
const READ_ONLY = ['crm.objects.custom.read', 'crm.schemas.custom.read'];

// The settings page (hubspot-app/src/app/settings/ChangeCatchSettings.tsx) renders exactly these fields. Changing
// this shape needs a matching page change and a hubspot-app upload.
test('GET /api/settings: the response shape the settings page relies on', async () => {
  const portals = new PortalStore({ path: ':memory:', key: parseKeyring(`t:${randomBytes(32).toString('base64')}`) });
  portals.saveInstall(P, 'rt', READ_ONLY); // custom read, no custom write
  portals.setWatchedPairs(P, [
    { objectTypeId: '0-3', associatedObjectTypeId: '0-1' },
    { objectTypeId: '2-9', associatedObjectTypeId: '0-1' },
  ]);
  const server = testAppServer({
    portals,
    installer: {
      objectTypes: async () => [
      { objectTypeId: '0-1', singular: 'Contact', plural: 'Contacts', custom: false },
      { objectTypeId: '2-9', singular: 'Pet', plural: 'Pets', custom: true },
      { objectTypeId: '0-2', singular: 'Company', plural: 'Companies', custom: false },
      { objectTypeId: '0-3', singular: 'Deal', plural: 'Deals', custom: false },
      ],
    },
    publicBaseUrl: 'http://localhost:3001',
    allowUnsigned: true,
  });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/api/settings?portalId=${P}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      portalId: P,
      // Display order: standard objects by rank (deal, company, contact), then custom by name.
      objectTypes: [
        { objectTypeId: '0-3', singular: 'Deal', plural: 'Deals', custom: false, selectable: true },
        { objectTypeId: '0-2', singular: 'Company', plural: 'Companies', custom: false, selectable: true },
        { objectTypeId: '0-1', singular: 'Contact', plural: 'Contacts', custom: false, selectable: true },
        { objectTypeId: '2-9', singular: 'Pet', plural: 'Pets', custom: true, selectable: false },
      ],
      customObjectsAvailable: true,
      customObjectsEnabled: false,
      enableCustomObjectsUrl: 'http://localhost:3001/install?custom=1',
      watchedPairs: [
        { objectTypeId: '0-3', associatedObjectTypeId: '0-1', active: true },
        { objectTypeId: '2-9', associatedObjectTypeId: '0-1', active: false },
      ],
      recommendedPairs: [
        { objectTypeId: '0-2', associatedObjectTypeId: '0-1' },
        { objectTypeId: '0-3', associatedObjectTypeId: '0-1' },
        { objectTypeId: '0-3', associatedObjectTypeId: '0-2' },
      ],
      stampSpacingSeconds: 3,
      spacing: { default: 3, min: 1, max: 600, presets: [3, 5, 10, 30, 60] },
      lastProvisionError: null,
    });
  } finally {
    server.close();
    portals.close();
  }
});
