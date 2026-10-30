// Create the ChangeCatch property group + properties on each object type (idempotent: existing ones are skipped).
// Usage (from tools/):
//   pnpm exec tsx src/properties-setup.ts --portal <portalId> --objects 0-1,0-3,2-xxx          (dry run: read only)
//   pnpm exec tsx src/properties-setup.ts --portal <portalId> --objects 0-1,0-3,2-xxx --yes    (creates)
// --portal falls back to HUBSPOT_TEST_PORTAL_ID. No defaults for portal or objects.
// Auth: the portal's stored install token (lib/portal-token.ts); HUBSPOT_TEST_REFRESH_TOKEN only as a warned fallback.
// On a custom object (2-xxx) a 403 means crm.schemas.custom.write was not granted to this install.
// The 3 label properties are multiple-checkbox enumerations; old free-text versions are migrated in place
// (status would-migrate/migrated). Then run src/labels-sync.ts to add one option per association label.
// Docs: see the header of service/src/hubspot/properties.ts.

import './lib/env.js'; // must stay first
import { writeFileSync } from 'node:fs';
import { CHANGECATCH_PROPERTIES, GROUP_NAME, ensureChangeCatchProperties, type SetupReport } from '@changecatch/service/hubspot/properties.js';
import { list, parseArgs, portalIdFrom, run } from './lib/cli.js';
import { samplePath } from './lib/paths.js';
import { getToolPortalToken } from './lib/portal-token.js';

run(async () => {
  const args = parseArgs();
  const objects = list(args, 'objects') ?? [];
  const yes = args.yes === true;
  if (objects.length === 0) {
    console.error('Usage: tsx src/properties-setup.ts --portal <portalId> --objects 0-1,0-3,2-xxx [--yes]');
    process.exit(1);
  }
  const portal = portalIdFrom(args);

  console.log(
    `${yes ? 'CREATING' : 'DRY RUN (add --yes to create)'}: group "${GROUP_NAME}" + ${CHANGECATCH_PROPERTIES.length} properties on ${objects.join(', ')} in portal ${portal}\n`,
  );
  const token = await getToolPortalToken({ portalId: portal });

  const reports: SetupReport[] = [];
  for (const objectType of objects) {
    const r = await ensureChangeCatchProperties(token, objectType, { dryRun: !yes });
    reports.push(r);
    console.log(`== ${objectType}`);
    console.log(`  group ${GROUP_NAME}: ${r.group}`);
    for (const p of r.properties) console.log(`  ${p.status.padEnd(15)} ${p.name}${p.detail ? `  (${p.detail})` : ''}`);
    if (r.missingScope) {
      console.log(`\n  !! 403 on ${objectType}: scope "${r.missingScope}" was NOT granted to this install.`);
      if (objectType.startsWith('2-'))
        console.log(
          '  !! crm.schemas.custom.write is not available, so the app cannot create properties on this custom object.\n' +
            '  !! Fallback: the admin creates the ChangeCatch properties on the custom object by hand (same names/types), and the app only writes values.',
        );
    }
    if (r.error && !r.missingScope) console.log(`  error: ${r.error}`);
    console.log('');
  }

  const out = samplePath(`properties-setup-${yes ? 'apply' : 'dryrun'}`);
  writeFileSync(out, JSON.stringify({ portal, objects, apply: yes, reports }, null, 2));
  console.log(`Saved report to ${out}`);
  console.log(`Next: tsx src/labels-sync.ts --portal ${portal} --objects ${objects.join(',')}${yes ? ' --yes' : ''}`);
});
