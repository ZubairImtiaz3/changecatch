// Loads .env and reads env vars. Every entry point imports this (directly or through a module that does).
//
// Files read, first one wins per variable (variables already set in the shell are never overwritten):
//   ./.env (current dir), service/.env, <repo>/.env   (docs/configuration.md: the normal place is <repo>/.env)
// Uses Node's built-in process.loadEnvFile, so it works the same from the repo root or from service/.

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** changecatch/service */
export const SERVICE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** changecatch (repo root) */
export const REPO_ROOT = resolve(SERVICE_ROOT, '..');

const seen = new Set<string>();
for (const f of [resolve('.env'), join(SERVICE_ROOT, '.env'), join(REPO_ROOT, '.env')]) {
  if (seen.has(f) || !existsSync(f)) continue;
  seen.add(f);
  process.loadEnvFile(f);
}

/**
 * The SQLite file shared by the API server and the worker: DB_PATH, else data/changecatch.db.
 * A relative path is relative to service/ (not the current dir), so both processes and the tools open the same file.
 */
export function dbPath(raw: string | undefined = process.env.DB_PATH): string {
  const p = raw || 'data/changecatch.db';
  if (p === ':memory:' || p.startsWith('file:') || isAbsolute(p)) return p;
  return resolve(SERVICE_ROOT, p);
}

/** Read a required env var. Throws a clear error if missing. */
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. See .env.example.`);
  return v;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}
