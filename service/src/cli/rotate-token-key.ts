// Re-encrypt every stored refresh token with the ACTIVE key (the first entry of TOKEN_ENC_KEYS).
// Usage: npx tsx src/cli/rotate-token-key.ts            (dry run: decrypts all rows, writes nothing)
//        npx tsx src/cli/rotate-token-key.ts --apply    (re-encrypts rows not on the active key)
// Env: TOKEN_ENC_KEYS (new key first, old keys after it), TOKEN_ENC_KEY (only while "v1:" rows exist), DB_PATH.
// Runbook: src/install/crypto.ts header. Token values are never printed; exit code 1 if any row failed to decrypt.

import '../lib/env.js'; // loads .env
import { PortalStore } from '../store/portals.js';
import { keyFromEnv } from '../install/crypto.js';
import { rotateTokens } from '../install/rotate.js';

const apply = process.argv.includes('--apply');
const key = keyFromEnv();
const store = new PortalStore({ key });
try {
  const r = rotateTokens(store.db, key, { dryRun: !apply });
  console.log(JSON.stringify({ ...r, failed: r.failed.map((f) => ({ portalId: f.portalId, keyId: f.keyId, error: f.error })) }, null, 2));
  if (!apply) console.log(`Dry run. ${r.wouldReencrypt} row(s) would be re-encrypted. Re-run with --apply to write.`);
  if (r.failed.length) {
    console.error(`${r.failed.length} row(s) could not be decrypted with the current keys. They were left unchanged.`);
    process.exitCode = 1;
  }
} finally {
  store.close();
}
