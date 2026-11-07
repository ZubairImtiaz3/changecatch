// Encryption for stored refresh tokens: AES-256-GCM, with key IDs so the key can be rotated.
//
// Keys (env):
//   TOKEN_ENC_KEYS = "id:key,id:key,..."  The FIRST entry is the active key (new ciphertexts use it); the others
//                                         only decrypt. id = [A-Za-z0-9_-]{1,32}. key = 32 random bytes, base64 or hex.
//   Make a key with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Stored format: "k<id>:<iv>:<tag>:<data>" (base64 parts; iv = 12 random bytes per encryption, tag = 16 bytes).
// The portal id is the AAD (additional authenticated data), so a token copied to another portal's row fails to decrypt.
//
// Rotation: docs/runbook.md.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface Keyring {
  /** Key used for new ciphertexts (the first TOKEN_ENC_KEYS entry). */
  active: { id: string; key: Buffer };
  /** Every key by id, for decrypting. */
  keys: Map<string, Buffer>;
}

/** Parse a 32-byte key from base64 or hex. Throws a clear error otherwise. */
function parseKey(raw: string | undefined, name: string): Buffer {
  if (!raw) throw new Error(`Missing ${name} (32 random bytes, base64 or hex). See docs/configuration.md.`);
  const s = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) throw new Error(`${name} must decode to 32 bytes, got ${buf.length}.`);
  return buf;
}

/** Build a keyring from the TOKEN_ENC_KEYS value. Throws on bad or duplicate entries, or no key at all. */
export function parseKeyring(keysRaw: string | undefined): Keyring {
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
  if (!active) throw new Error('Missing env var TOKEN_ENC_KEYS ("<id>:<32-byte key>", base64 or hex). See docs/configuration.md.');
  return { active, keys };
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

export function encryptToken(plain: string, ring: Keyring, aad: string): string {
  const { iv, tag, data } = gcmEncrypt(plain, ring.active.key, aad);
  return `k${ring.active.id}:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

/** Key id of a stored value, or null for an unknown format. */
export function keyIdOf(stored: string): string | null {
  const m = /^k([A-Za-z0-9_-]{1,32}):/.exec(stored);
  return m ? m[1] : null;
}

export function decryptToken(stored: string, ring: Keyring, aad: string): string {
  const parts = stored.split(':');
  const id = keyIdOf(stored);
  if (!id || parts.length !== 4) throw new Error('Unknown token format');
  const k = ring.keys.get(id);
  if (!k) throw new Error(`Token was encrypted with key id "${id}", which is not in TOKEN_ENC_KEYS`);
  const [, iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64'));
  return gcmDecrypt(k, iv, tag, data, aad);
}

/** True if this value is already encrypted with the keyring's active key. */
export function usesActiveKey(stored: string, ring: Keyring): boolean {
  return keyIdOf(stored) === ring.active.id;
}
