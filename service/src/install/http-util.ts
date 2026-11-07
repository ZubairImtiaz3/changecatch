// HTTP plumbing shared by the app server routes: the install route paths, security headers, the body limit, JSON replies, redirects, and
// clipping request values for log lines (secrets and CR/LF are handled by the logger, src/obs/log.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Our install link: step 1 asks required + optional scopes, step 2 ("?custom=1") adds the custom write scopes (scopes.ts). */
export const installPath = (step: 1 | 2): string => (step === 2 ? '/install?custom=1' : '/install');
/** The step an /install request asks for (the inverse of installPath). */
export const installStepOf = (url: URL): 1 | 2 => (url.searchParams.get('custom') === '1' ? 2 : 1);

export const MAX_BODY_BYTES = 64 * 1024;

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  // Nothing here is meant to be framed: the settings page is a HubSpot UI extension that calls us via the
  // server-side hubspot.fetch proxy, not an iframe. Only the OAuth callback relaxes this (oauth-flow.ts).
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export class BodyTooLargeError extends Error {}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return reject(new BodyTooLargeError());
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        req.pause();
        reject(new BodyTooLargeError());
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}

/** 302 to a target the caller built or validated (HubSpot authorize URL, returnUrl, settings tab). */
export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

/** A request value in a log line: at most 300 chars (the logger redacts secrets and strips CR/LF). */
export const clip = (v: unknown): string => String(v).slice(0, 300);
