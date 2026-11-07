// HubSpot request signature check (v3 only). Used by the settings API (/api/settings).
// Docs (checked 2026-10-30):
//   https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation.md
//
// v3 (preferred): header X-HubSpot-Signature-v3 = base64(HMAC-SHA256(clientSecret, method + uri + rawBody + timestamp)),
//   timestamp from X-HubSpot-Request-Timestamp (ms). Reject if older than 5 minutes. Constant-time compare.
//   In the URI's query string, decode %3A %2F %3F %40 %21 %24 %27 %28 %29 %2A %2C %3B.
// HubSpot also sends older versions (v2, X-HubSpot-Signature); we never accept them: v2 has no timestamp, so a
// captured request could be replayed forever (security review M1). hubspot.fetch always sends v3.

import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

const DECODE: Record<string, string> = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$',
  '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
};

/** Normalise the URI the way HubSpot does before signing (v3): drop fragment, decode listed chars in the query only. */
function normaliseUriV3(uri: string): string {
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
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

function header(h: VerifyInput['headers'], name: string): string | undefined {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function verifyHubSpotSignature(input: VerifyInput): VerifyResult {
  const { secret, method, uri, rawBody, headers, now = Date.now() } = input;
  const sig = header(headers, 'x-hubspot-signature-v3');
  if (!sig) return { ok: false, reason: 'v3 signature required' };
  const ts = header(headers, 'x-hubspot-request-timestamp');
  if (!ts || !/^\d+$/.test(ts)) return { ok: false, reason: 'missing or bad timestamp' };
  if (Math.abs(now - Number(ts)) > MAX_TIMESTAMP_AGE_MS) return { ok: false, reason: 'timestamp too old' };
  return safeEqual(signV3(secret, method, uri, rawBody, ts), sig) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}
