// Loads .env for the tools. Import this FIRST in every tool (before any @changecatch/service import), because
// service code reads process.env at import time and its own loader ('dotenv/config') only looks in the current dir.
//
// Files read, first one wins per variable (variables already set in the shell are never overwritten):
//   ./.env (current dir), tools/.env, service/.env, <repo>/.env
// Uses Node's built-in process.loadEnvFile (Node >= 20.12), so tools need no dotenv dependency.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT, SERVICE_ROOT, TOOLS_ROOT, dbPath } from './paths.js';

const seen = new Set<string>();
for (const f of [resolve('.env'), join(TOOLS_ROOT, '.env'), join(SERVICE_ROOT, '.env'), join(REPO_ROOT, '.env')]) {
  if (seen.has(f) || !existsSync(f)) continue;
  seen.add(f);
  process.loadEnvFile(f);
}

// Pin DB_PATH to an absolute path now, before service modules read it.
dbPath();

/** Read a required env var. Throws a clear error if missing. */
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. See .env.example.`);
  return v;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}
