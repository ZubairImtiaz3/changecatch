// Tiny shared CLI helpers for the tools. Not a tool itself.

import { writeFileSync } from 'node:fs';
import { HttpError } from '@changecatch/service/lib/http.js';
import { samplePath } from './paths.js';

export type Args = { _: string[]; [k: string]: string | boolean | string[] };

/** Parse `--key value` and `--flag` args. Bare words go into `_`. */
export function parseArgs(argv = process.argv.slice(2)): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

export function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

export function num(args: Args, key: string): number | undefined {
  const v = str(args, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got "${v}"`);
  return n;
}

/** Comma-separated list arg, e.g. --objects 0-1,0-3 */
export function list(args: Args, key: string): string[] | undefined {
  return str(args, key)
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Save raw JSON to <samples>/<name>-<timestamp>.json and return the path. */
export function saveSample(name: string, data: unknown): string {
  const file = samplePath(name);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** Run main() with readable errors (HubSpot error body included, never the token). */
export function run(main: () => Promise<void>): void {
  main().catch((e) => {
    if (e instanceof HttpError) {
      console.error(`HubSpot error ${e.status}:`, JSON.stringify(e.body, null, 2));
      saveSample('error', { status: e.status, body: e.body, message: e.message });
    } else console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

/**
 * Portal for a tool: --portal <id>, else HUBSPOT_TEST_PORTAL_ID. No default: exits with a message if neither is a positive integer.
 */
export function portalIdFrom(args: Args): number {
  const raw = str(args, 'portal') ?? process.env.HUBSPOT_TEST_PORTAL_ID;
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) {
    console.error('No portal: pass --portal <portalId> or set HUBSPOT_TEST_PORTAL_ID. There is no default.');
    process.exit(1);
  }
  return n;
}
