// HubSpot request signature checks (v3, with a v2 helper kept for tests). Used by the settings API (/api/settings).
// Docs (checked 2026-10-30):
//   https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation.md
//
// v3 (preferred): header X-HubSpot-Signature-v3 = base64(HMAC-SHA256(clientSecret, method + uri + rawBody + timestamp)),
//   timestamp from X-HubSpot-Request-Timestamp (ms). Reject if older than 5 minutes. Constant-time compare.
//   In the URI's query string, decode %3A %2F %3F %40 %21 %24 %27 %28 %29 %2A %2C %3B.
// v2 (fallback): header X-HubSpot-Signature (+ X-HubSpot-Signature-Version: v2) = hex(SHA-256(clientSecret + method + uri + rawBody)).
//   HubSpot sends v3 plus older versions on signed requests. The settings API requires v3 (requireV3);
//   v2 is accepted only when requireV3 is false. v2 has no timestamp (no replay protection).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

const DECODE: Record<string, string> = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$',
  '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
};

/** Normalise the URI the way HubSpot does before signing (v3): drop fragment, decode listed chars in the query only. */
export function normaliseUriV3(uri: string): string {
  const noFrag = uri.split('#')[0];
  const q = noFrag.indexOf('?');
  if (q === -1) return noFrag;
  return noFrag.slice(0, q + 1) + noFrag.slice(q + 1).replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi, (m) => DECODE[m.toUpperCase()]);
}

export function signV3(secret: string, method: string, uri: string, rawBody: string, timestamp: string | number): string {
  return createHmac('sha256', secret)
    .update(`${method.toUpperCase()}${normaliseUriV3(uri)}${rawBody}${timestamp}`, 'utf8')
    .digest('base64');
}

export function signV2(secret: string, method: string, uri: string, rawBody: string): string {
  return createHash('sha256').update(`${secret}${method.toUpperCase()}${uri}${rawBody}`, 'utf8').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface VerifyInput {
  secret: string;
  method: string;
  /** Full URI HubSpot called, e.g. https://changecatch.example.com/api/settings?x=1 */
  uri: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  now?: number;
  /** Accept ONLY v3 (timestamped). Use for the settings API: hubspot.fetch always sends v3, and v2 can be replayed forever. */
  requireV3?: boolean;
}

export type VerifyResult =
  | { ok: true; version: 'v3' | 'v2' }
  | { ok: false; version: 'v3' | 'v2' | 'none'; reason: string };

function header(h: VerifyInput['headers'], name: string): string | undefined {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function verifyHubSpotSignature(input: VerifyInput): VerifyResult {
  const { secret, method, uri, rawBody, headers, now = Date.now(), requireV3 = false } = input;

  const v3 = header(headers, 'x-hubspot-signature-v3');
  if (v3) {
    const ts = header(headers, 'x-hubspot-request-timestamp');
    if (!ts || !/^\d+$/.test(ts)) return { ok: false, version: 'v3', reason: 'missing or bad timestamp' };
    if (Math.abs(now - Number(ts)) > MAX_TIMESTAMP_AGE_MS) return { ok: false, version: 'v3', reason: 'timestamp too old' };
    return safeEqual(signV3(secret, method, uri, rawBody, ts), v3)
      ? { ok: true, version: 'v3' }
      : { ok: false, version: 'v3', reason: 'signature mismatch' };
  }

  const v2 = header(headers, 'x-hubspot-signature');
  if (requireV3) return { ok: false, version: v2 ? 'v2' : 'none', reason: 'v3 signature required' };
  const ver = header(headers, 'x-hubspot-signature-version');
  if (v2 && (!ver || ver.toLowerCase() === 'v2')) {
    return safeEqual(signV2(secret, method, uri, rawBody), v2.toLowerCase())
      ? { ok: true, version: 'v2' }
      : { ok: false, version: 'v2', reason: 'signature mismatch' };
  }

  return { ok: false, version: 'none', reason: 'no signature header' };
}
