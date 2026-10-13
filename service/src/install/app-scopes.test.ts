// Guards the one-source-of-truth rule: APP_SCOPES must match hubspot-app/src/app/app-hsmeta.json exactly.
// (Reading the other package is fine in a test; the service itself never does it at runtime.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_SCOPES } from './app-scopes.js';

test('APP_SCOPES matches hubspot-app/src/app/app-hsmeta.json', () => {
  const path = fileURLToPath(new URL('../../../hubspot-app/src/app/app-hsmeta.json', import.meta.url));
  const auth = JSON.parse(readFileSync(path, 'utf8')).config.auth;
  const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();
  assert.deepEqual(sorted(APP_SCOPES.required), sorted(auth.requiredScopes), 'requiredScopes drifted');
  assert.deepEqual(sorted(APP_SCOPES.optional), sorted(auth.optionalScopes), 'optionalScopes drifted');
  assert.deepEqual(sorted(APP_SCOPES.conditional), sorted(auth.conditionallyRequiredScopes), 'conditionallyRequiredScopes drifted');
});
