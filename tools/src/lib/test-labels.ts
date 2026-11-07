// Which Deal->Contact association labels the e2e check and the load test use. Not a tool itself.
// Only NAMES are configured; the type IDs are always looked up in the portal at runtime (labels API), so nothing
// portal-specific is hard-coded.
//
// Names: --labels "A,B,C" (comma-separated), else config.tools.testLabels (CHANGECATCH_TEST_LABELS), else the three below.
// The e2e check uses the first two, the load test all three. They must exist as Deal->Contact labels in the portal.

import { type Args, list } from './cli.js';

export const DEFAULT_TEST_LABELS = ['Influencer', 'Decision maker', 'Billing contact'];

export function testLabelNames(args: Args, needed: number, configured: string[] | undefined): string[] {
  const names = list(args, 'labels') ?? configured ?? DEFAULT_TEST_LABELS;
  if (new Set(names).size < needed) throw new Error(`Need ${needed} different label names (--labels "A,B${needed > 2 ? ',C' : ''}"), got: ${names.join(', ')}`);
  return names.slice(0, needed);
}

/** Find a label by name in a labels-API result; the error lists what the portal has. */
export function labelByName<L extends { label: string | null }>(all: L[], name: string): L {
  const l = all.find((x) => x.label === name);
  if (!l) {
    const have = all.map((x) => x.label).filter(Boolean);
    throw new Error(`Deal->Contact label "${name}" not found in this portal (have: ${have.join(', ') || 'none'}). Create it, or pick others with --labels.`);
  }
  return l;
}
