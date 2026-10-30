// Where things live, independent of the current directory (tools may run from the repo root or from tools/).
// Not a script itself. Import this (or ./env.ts, which imports it) FIRST in every tool.

import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** changecatch/tools */
export const TOOLS_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** changecatch (repo root) */
export const REPO_ROOT = resolve(TOOLS_ROOT, '..');
/** changecatch/service: the worker and app server run from here, so a relative DB_PATH is relative to it. */
export const SERVICE_ROOT = join(REPO_ROOT, 'service');

/**
 * The worker's SQLite file. DB_PATH if set (relative paths are resolved against service/, where the worker runs),
 * else service/data/changecatch.db (the service's own default, seen from service/).
 * Also writes the absolute path back to process.env.DB_PATH, so service code that reads DB_PATH itself
 * (PortalStore, Store) opens the same file whatever the current directory is.
 */
export function dbPath(): string {
  const raw = process.env.DB_PATH || 'data/changecatch.db';
  const abs = isAbsolute(raw) ? raw : resolve(SERVICE_ROOT, raw);
  process.env.DB_PATH = abs;
  return abs;
}

/** Output folder for JSON reports: SAMPLES_DIR if set, else tools/samples (git-ignore it). Created on demand. */
export function samplesDir(): string {
  const dir = process.env.SAMPLES_DIR ? resolve(process.env.SAMPLES_DIR) : join(TOOLS_ROOT, 'samples');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** samples/<name>-<timestamp>.json (path only; the caller writes it). */
export function samplePath(name: string): string {
  return join(samplesDir(), `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}
