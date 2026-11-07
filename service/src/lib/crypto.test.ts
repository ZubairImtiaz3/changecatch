// Refresh-token encryption at rest (lib/crypto.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptToken, encryptToken, parseKeyring } from './crypto.js';

const b64 = () => randomBytes(32).toString('base64');

test('crypto: k<id> format, unique IV, tag verified, key ids checked', () => {
  const k1 = b64();
  const k2 = b64();
  const ring = parseKeyring(`new:${k2},old:${k1}`);
  const enc = encryptToken('rt-1', ring, '7');
  assert.match(enc, /^knew:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  const [, iv, tag] = enc.split(':');
  assert.equal(Buffer.from(iv, 'base64').length, 12);
  assert.equal(Buffer.from(tag, 'base64').length, 16);
  assert.notEqual(encryptToken('rt-1', ring, '7').split(':')[1], iv, 'fresh IV each time');
  assert.equal(decryptToken(enc, ring, '7'), 'rt-1');
  assert.throws(() => decryptToken(enc, ring, '8'), 'AAD bound to portal');
  const parts = enc.split(':');
  const flipped = Buffer.from(parts[3], 'base64');
  flipped[0] ^= 1;
  assert.throws(() => decryptToken([...parts.slice(0, 3), flipped.toString('base64')].join(':'), ring, '7'), 'tampered data');
  assert.throws(() => decryptToken(enc.replace(/^knew:/, 'kold:'), ring, '7'), 'wrong key id');
  assert.throws(() => decryptToken(enc, parseKeyring(`old:${k1}`), '7'), /not in TOKEN_ENC_KEYS/);
  assert.throws(() => decryptToken('v1:AAAA', ring, '7'), /Unknown token format/);

  assert.equal(decryptToken(encryptToken('rt-2', parseKeyring(`h:${Buffer.from(k1, 'base64').toString('hex')}`), '7'), parseKeyring(`h:${k1}`), '7'), 'rt-2', 'hex and base64 forms of a key are the same key');
  assert.throws(() => parseKeyring(`a:${randomBytes(16).toString('base64')}`), /32 bytes/);
  assert.throws(() => parseKeyring('bad id:xx'));
  assert.throws(() => parseKeyring(`a:${k1},a:${k2}`), /twice/);
  assert.throws(() => parseKeyring(undefined), /TOKEN_ENC_KEYS/);
});
