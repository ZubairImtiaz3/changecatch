// The tools' one argv parser. Not a tool itself.

export type Args = { _: string[]; [k: string]: string | boolean | string[] };

/**
 * Parse `--key value` and `--flag` args. Bare words go into `_`.
 * Keys in `flags` are always booleans, so `--yes mixed` keeps `mixed` as a bare word.
 */
export function parseArgs(argv = process.argv.slice(2), flags: readonly string[] = []): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!flags.includes(key) && next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

export function flag(args: Args, key: string): boolean {
  return args[key] === true;
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

/** Comma-separated list arg, e.g. --labels "A,B" */
export function list(args: Args, key: string): string[] | undefined {
  return str(args, key)
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** HUBSPOT_SETUP_TOKEN (config.tools.setupToken), required by the steps that change data. */
export function setupTokenOf(tools: { setupToken: string | undefined }): string {
  if (!tools.setupToken) throw new Error('Missing env var HUBSPOT_SETUP_TOKEN. See .env.example.');
  return tools.setupToken;
}

/**
 * Portal for a tool: --portal <id>, else config.tools.testPortalId (HUBSPOT_TEST_PORTAL_ID). No default: exits with a
 * message if neither is a positive integer.
 */
export function portalIdFrom(args: Args, testPortalId: number | undefined): number {
  const raw = str(args, 'portal');
  const n = raw === undefined ? testPortalId : Number(raw);
  if (n === undefined || !Number.isInteger(n) || n <= 0) {
    console.error('No portal: pass --portal <portalId> or set HUBSPOT_TEST_PORTAL_ID. There is no default.');
    process.exit(1);
  }
  return n;
}
