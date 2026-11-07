// Where tool output goes, independent of the current directory (tools may run from the repo root or from tools/).
// The .env loader, REPO_ROOT and DB_PATH come from the service config (@changecatch/service/lib/config.js).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** changecatch/tools */
export const TOOLS_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** samples/<name>-<timestamp>.json in config.tools.samplesDir (SAMPLES_DIR), else tools/samples. Created on demand. */
export function samplePath(samplesDir: string | undefined, name: string): string {
  const dir = samplesDir ?? join(TOOLS_ROOT, 'samples');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}
