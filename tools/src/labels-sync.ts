// Sync the options of the 3 label properties (changecatch_label_before / _after / _labels_current) with the portal's
// association labels. Also migrates them from the old free-text type to multiple checkboxes if needed.
// Usage (from tools/):
//   pnpm exec tsx src/labels-sync.ts --portal <portalId> --objects 0-1,0-3,2-xxx           (dry run: read only)
//   pnpm exec tsx src/labels-sync.ts --portal <portalId> --objects 0-1,0-3,2-xxx --yes     (PATCHes properties)
//   ... --pairs 0-3:0-1,2-xxx:0-1    (watched pairs; default = every pair among --objects)
// --portal falls back to HUBSPOT_TEST_PORTAL_ID. No defaults for portal or objects.
// Auth: the portal's stored install token (lib/portal-token.ts); HUBSPOT_TEST_REFRESH_TOKEN only as a warned fallback.
// Idempotent and additive: existing options are never removed. Docs: see the header of service/src/hubspot/properties.ts.

import './lib/env.js'; // must stay first
import type { WatchedPair } from '@changecatch/service/core/types.js';
import { objectTypeNames, syncLabelOptions, type LabelSyncReport } from '@changecatch/service/hubspot/properties.js';
import { list, parseArgs, portalIdFrom, run, saveSample } from './lib/cli.js';
import { getToolPortalToken } from './lib/portal-token.js';

run(async () => {
  const args = parseArgs();
  const objects = list(args, 'objects') ?? [];
  const yes = args.yes === true;
  if (objects.length === 0) {
    console.error('Usage: tsx src/labels-sync.ts --portal <portalId> --objects 0-1,0-3,2-xxx [--pairs a:b,c:d] [--yes]');
    process.exit(1);
  }
  const portal = portalIdFrom(args);

  const pairArg = list(args, 'pairs');
  const pairs: WatchedPair[] = pairArg
    ? pairArg.map((p) => {
        const [a, b] = p.split(':');
        if (!a || !b) throw new Error(`Bad --pairs entry "${p}". Use from:to, e.g. 0-3:0-1`);
        return { objectTypeId: a, associatedObjectTypeId: b };
      })
    : objects.flatMap((a, i) => objects.slice(i + 1).map((b) => ({ objectTypeId: a, associatedObjectTypeId: b })));

  console.log(`${yes ? 'APPLYING' : 'DRY RUN (add --yes to apply)'}: label options on ${objects.join(', ')} in portal ${portal}`);
  console.log(`Watched pairs: ${pairs.map((p) => `${p.objectTypeId}<->${p.associatedObjectTypeId}`).join(', ')}\n`);

  const token = await getToolPortalToken({ portalId: portal });
  const names = await objectTypeNames(token, [...new Set(pairs.flatMap((p) => [p.objectTypeId, p.associatedObjectTypeId]))]);

  const reports: LabelSyncReport[] = [];
  for (const objectType of objects) {
    const r = await syncLabelOptions(token, portal, objectType, pairs, { dryRun: !yes, objectTypeNames: names });
    reports.push(r);
    console.log(`== ${objectType} (${names[objectType] ?? objectType}), other types: ${r.otherObjectTypeIds.join(', ') || '-'}`);
    console.log(`  desired options (${r.options.length}):`);
    for (const o of r.options) console.log(`    ${o.value.padEnd(40)} "${o.label}"`);
    for (const p of r.properties) {
      console.log(`  ${p.status.padEnd(14)} ${p.name}${p.detail ? `  (${p.detail})` : ''}`);
      if (p.added.length) console.log(`                 + ${p.added.join(', ')}`);
    }
    for (const e of r.labelErrors) console.log(`  labels ${e.from}->${e.to} failed: ${e.error}`);
    if (r.error) console.log(`  error: ${r.error}`);
    console.log('');
  }
  console.log(`Saved report to ${saveSample(`labels-sync-${yes ? 'apply' : 'dryrun'}`, { portal, objects, pairs, apply: yes, reports })}`);
});
