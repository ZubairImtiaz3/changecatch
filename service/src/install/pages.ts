// The HTML pages a browser can land on during install (error, governance, installed, setup-unfinished) and their
// escaping. Copy changes happen here; the flow that picks a page lives in oauth-flow.ts.

import type { ServerResponse } from 'node:http';
import { installPath } from './http-util.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function sendHtml(res: ServerResponse, status: number, title: string, msg: string): void {
  sendPage(res, status, title, `<p>${esc(msg)}</p>`);
}

/** bodyHtml must already be escaped / trusted markup. */
export function sendPage(res: ServerResponse, status: number, title: string, bodyHtml: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:sans-serif;max-width:40em;margin:3em auto;line-height:1.5"><h1>${esc(title)}</h1>${bodyHtml}</body>`);
}

const LATER = 'Custom objects can be enabled later from the ChangeCatch settings page in HubSpot.';

/**
 * HubSpot APP GOVERNANCE: a super admin must approve the app and turn on its extra data permissions.
 * Seen text (2026-10-30, Enterprise custom-object re-test): "Authorization failed because this
 * app hasn't been approved to access the required scopes [...] Please reach out to your account super admin to add the
 * app's permissions in your account's app governance settings." KB: https://knowledge.hubspot.com/integrations/manage-access-to-apps
 */
function isGovernanceError(error: string | null, description: string | null): boolean {
  return /(?:has ?n[o']t been approved|not been approved|app governance|super ?admin)/i.test(`${error ?? ''} ${description ?? ''}`);
}

const GOVERNANCE_STEPS_HTML =
  '<ol>' +
  '<li>In HubSpot, go to <b>Settings</b> (gear icon) &gt; <b>Integrations</b> &gt; <b>Connected Apps</b>.</li>' +
  '<li>Open the <b>Approved apps</b> tab and click <b>ChangeCatch</b>. (Not listed? Click <b>Approve apps</b>, search for ChangeCatch, click <b>Approve</b>, then <b>Enable all</b>.)</li>' +
  '<li>Click <b>Manage access</b>.</li>' +
  '<li>Under data permissions, turn on the <b>custom object</b> permissions (custom objects write and custom object schemas write). Save.</li>' +
  '</ol>';

/** The friendly page for an OAuth callback that came back with ?error=. Pure (testable); the caller logs. */
export function oauthErrorPage(o: { error: string; description: string | null; step: 1 | 2; ref: string }): { status: number; title: string; html: string; kind: 'governance' | 'custom-declined' | 'other' } {
  const governance = isGovernanceError(o.error, o.description);
  const retry = installPath(o.step === 2 || governance ? 2 : 1);
  const tryAgain = `<p><a href="${retry}">Try again</a></p>`;
  const meanwhile = '<p>Meanwhile, ChangeCatch keeps working for contacts, companies and deals. Only custom-object pairs stay locked.</p>';
  const said = o.description ? `<p>HubSpot said: <i>${esc(o.description.slice(0, 500))}</i></p>` : '';
  const refLine = `<p style="color:#666;font-size:.9em">Reference: ${esc(o.ref)}</p>`;
  if (governance) {
    return {
      status: 403, kind: 'governance', title: 'A super admin needs to approve ChangeCatch',
      html:
        '<p>Your HubSpot account uses <b>app approval</b> (app governance). ChangeCatch&rsquo;s custom-object permissions have not been allowed yet, so HubSpot stopped the request.</p>' +
        said + '<p><b>Ask a super admin to do this:</b></p>' + GOVERNANCE_STEPS_HTML +
        '<p>Then click <b>Try again</b> below (or <b>Enable custom objects</b> on the ChangeCatch settings page) and approve.</p>' +
        tryAgain + meanwhile + refLine,
    };
  }
  if (o.step === 2) {
    // Declined (or failed) the custom-object consent: the first install already worked. Never loop back automatically.
    return {
      status: 200, kind: 'custom-declined', title: 'ChangeCatch is installed',
      html:
        `<p>ChangeCatch works for contacts, companies and deals. ${LATER}</p>` +
        said +
        '<p>If HubSpot blocked the request because your company requires app approval, a super admin must first allow ChangeCatch&rsquo;s custom-object permissions:</p>' +
        GOVERNANCE_STEPS_HTML + tryAgain + refLine,
    };
  }
  const code = /^[a-z_]{1,64}$/.test(o.error) ? ` (${esc(o.error)})` : '';
  return {
    status: 400, kind: 'other', title: 'Install failed',
    html:
      `<p>HubSpot did not complete the install${code}. Nothing was changed in your account.</p>` + said +
      '<p>If your company requires app approval, a super admin may need to approve ChangeCatch first (Settings &gt; Integrations &gt; Connected Apps &gt; Approved apps).</p>' +
      tryAgain + refLine,
  };
}

/** Shown when HUBSPOT_APP_ID isn't configured, so we can't send the browser to the settings tab. */
export function sendInstalledPage(res: ServerResponse, o: { portalId: number; pairCount: number; customLater: boolean }): void {
  const note = o.customLater ? ` ${LATER}` : '';
  sendHtml(res, 200, 'ChangeCatch is installed',
    `Watching ${o.pairCount} object pair(s) in account ${o.portalId}. Change them in HubSpot under Settings > Connected apps > ChangeCatch.${note} You can close this tab.`);
}

/** Tokens are saved but provisioning failed; settingsUrl (or null) becomes an "Open ChangeCatch settings" button. */
export function sendSetupUnfinishedPage(res: ServerResponse, ref: string, settingsUrl: string | null): void {
  const button = settingsUrl
    ? `<p><a href="${esc(settingsUrl)}" style="display:inline-block;padding:.6em 1.2em;background:#ff7a59;color:#fff;border-radius:4px;text-decoration:none">${esc('Open ChangeCatch settings in HubSpot')}</a></p>`
    : '';
  sendPage(res, 500, 'Installed, but setup did not finish',
    `<p>${esc(`ChangeCatch is installed, but setup did not finish. Open the ChangeCatch settings page in HubSpot and press Save to retry. Reference: ${ref}`)}</p>` + button);
}
