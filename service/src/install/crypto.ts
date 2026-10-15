// Encryption for stored refresh tokens: AES-256-GCM, with key IDs so the key can be rotated.
//
// Keys (env):
//   TOKEN_ENC_KEYS = "id:key,id:key,..."  The FIRST entry is the active key (new ciphertexts use it); the others
//                                         only decrypt. id = [A-Za-z0-9_-]{1,32}. key = 32 random bytes, base64 or hex.
//   TOKEN_ENC_KEY  = key                  Legacy single key. Still needed to read old "v1:" ciphertexts until
//                                         src/cli/rotate-token-key.ts has re-encrypted them. If TOKEN_ENC_KEYS is
//                                         not set, it is also the active key and new values keep the "v1:" format.
//   Make a key with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Stored formats:
//   "k<id>:<iv>:<tag>:<data>"  (current; base64 parts; iv = 12 random bytes per encryption, tag = 16 bytes)
//   "v1:" + base64(iv[12] | tag[16] | ciphertext)  (legacy; decrypted with TOKEN_ENC_KEY)
// The portal id is the AAD (additional authenticated data), so a token copied to another portal's row fails to decrypt.
//
// Rotation runbook: add the new key FIRST in TOKEN_ENC_KEYS (keep the old one after it), restart app server + worker,
// run `npx tsx src/cli/rotate-token-key.ts --apply`, then remove the old key (and TOKEN_ENC_KEY) and restart again.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const LEGACY_PREFIX = 'v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface Keyring {
  /** Key used for new ciphertexts. id null = legacy TOKEN_ENC_KEY only (writes the "v1:" format). */
  active: { id: string | null; key: Buffer };
  /** Keys by id, for "k<id>:" ciphertexts. */
  keys: Map<string, Buffer>;
  /** TOKEN_ENC_KEY, for "v1:" ciphertexts. */
  legacy?: Buffer;
}

/** A plain Buffer (legacy single key) or a full keyring. PortalStore stores what keyFromEnv() returns. */
export type TokenKey = Buffer | Keyring;

const KEYRING = Symbol('changecatch.keyring');
type KeyWithRing = Buffer & { [KEYRING]?: Keyring };

/** Parse a 32-byte key from base64 or hex. Throws a clear error otherwise. */
export function parseKey(raw: string | undefined, name = 'TOKEN_ENC_KEY'): Buffer {
  if (!raw) throw new Error(`Missing env var ${name} (32 random bytes, base64 or hex). See docs/install-flow.md.`);
  const s = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) throw new Error(`${name} must decode to 32 bytes, got ${buf.length}.`);
  return buf;
}

/** Build a keyring from TOKEN_ENC_KEYS / TOKEN_ENC_KEY values. Throws on bad or duplicate entries, or no key at all. */
export function parseKeyring(keysRaw: string | undefined, legacyRaw: string | undefined): Keyring {
  const legacy = legacyRaw?.trim() ? parseKey(legacyRaw) : undefined;
  const keys = new Map<string, Buffer>();
  let active: Keyring['active'] | undefined;
  for (const entry of (keysRaw ?? '').split(',').map((e) => e.trim()).filter(Boolean)) {
    const i = entry.indexOf(':');
    const id = i > 0 ? entry.slice(0, i) : '';
    if (!KEY_ID_RE.test(id)) throw new Error('TOKEN_ENC_KEYS entries must look like "<id>:<key>" with id [A-Za-z0-9_-]{1,32}.');
    if (keys.has(id)) throw new Error(`TOKEN_ENC_KEYS has key id "${id}" twice.`);
    const key = parseKey(entry.slice(i + 1), `TOKEN_ENC_KEYS key "${id}"`);
    keys.set(id, key);
    active ??= { id, key };
  }
  if (!active) {
    if (!legacy) throw new Error('Missing env var TOKEN_ENC_KEYS (or legacy TOKEN_ENC_KEY). See docs/install-flow.md.');
    active = { id: null, key: legacy };
  }
  return { active, keys, legacy };
}

export function keyringFromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
  return parseKeyring(env.TOKEN_ENC_KEYS, env.TOKEN_ENC_KEY);
}

/**
 * The active key as a Buffer, carrying the whole keyring with it (PortalStore types its key as a Buffer).
 * encryptToken/decryptToken pick the keyring up from it, so key ids and rotation work without store changes.
 */
export function keyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  return withKeyring(keyringFromEnv(env));
}

export function withKeyring(ring: Keyring): Buffer {
  const b = Buffer.from(ring.active.key) as KeyWithRing;
  Object.defineProperty(b, KEYRING, { value: ring, enumerable: false });
  return b;
}

/** Resolve a key argument to a keyring. A bare Buffer = a legacy single key. */
export function toKeyring(k: TokenKey): Keyring {
  if (Buffer.isBuffer(k)) return (k as KeyWithRing)[KEYRING] ?? { active: { id: null, key: k }, keys: new Map(), legacy: k };
  return k;
}

function gcmEncrypt(plain: string, key: Buffer, aad: string) {
  const iv = randomBytes(IV_LEN); // unique random IV per encryption
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  c.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv, tag: c.getAuthTag(), data };
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, data: Buffer, aad: string): string {
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) throw new Error('Token ciphertext is malformed');
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag); // final() throws if the tag doesn't verify
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

export function encryptToken(plain: string, key: TokenKey, aad: string): string {
  const { active } = toKeyring(key);
  const { iv, tag, data } = gcmEncrypt(plain, active.key, aad);
  if (active.id === null) return LEGACY_PREFIX + Buffer.concat([iv, tag, data]).toString('base64');
  return `k${active.id}:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

/** Key id of a stored value: the id, 'legacy' for "v1:", or null for an unknown format. */
export function keyIdOf(stored: string): string | null {
  if (stored.startsWith(LEGACY_PREFIX)) return 'legacy';
  const m = /^k([A-Za-z0-9_-]{1,32}):/.exec(stored);
  return m ? m[1] : null;
}

export function decryptToken(stored: string, key: TokenKey, aad: string): string {
  const ring = toKeyring(key);
  if (stored.startsWith(LEGACY_PREFIX)) {
    if (!ring.legacy) throw new Error('Token uses the legacy v1 format but TOKEN_ENC_KEY is not set');
    const buf = Buffer.from(stored.slice(LEGACY_PREFIX.length), 'base64');
    if (buf.length < IV_LEN + TAG_LEN) throw new Error('Token ciphertext too short');
    return gcmDecrypt(ring.legacy, buf.subarray(0, IV_LEN), buf.subarray(IV_LEN, IV_LEN + TAG_LEN), buf.subarray(IV_LEN + TAG_LEN), aad);
  }
  const parts = stored.split(':');
  const id = keyIdOf(stored);
  if (!id || id === 'legacy' || parts.length !== 4) throw new Error('Unknown token format');
  const k = ring.keys.get(id);
  if (!k) throw new Error(`Token was encrypted with key id "${id}", which is not in TOKEN_ENC_KEYS`);
  const [, iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64'));
  return gcmDecrypt(k, iv, tag, data, aad);
}

/** True if this value is already encrypted with the keyring's active key. */
export function usesActiveKey(stored: string, key: TokenKey): boolean {
  const { active } = toKeyring(key);
  return keyIdOf(stored) === (active.id ?? 'legacy');
}
