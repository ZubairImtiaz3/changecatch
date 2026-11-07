// Journal file download (hubspot/journal.ts). No network: fetch is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DownloadRejectedError, downloadJournalFile, JOURNAL_MAX_FILE_BYTES } from './journal.js';
import { HubSpotError } from '../lib/http.js';

test('download: only https HubSpot journal bucket on S3 is fetched; size capped; 5xx retried', async () => {
  const ok = 'https://hubspot-webhooks-journal-na1.s3.amazonaws.com/f?sig=1';
  let calls = 0;
  let respond: () => Response = () => new Response('{"offset":"o"}');
  const real = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL, init: RequestInit = {}) => {
    assert.equal(init.redirect, 'error', 'a redirect is never followed');
    calls++;
    return respond();
  }) as typeof fetch;
  try {
    for (const bad of [
      'http://hubspot-webhooks-journal-na1.s3.amazonaws.com/x',
      'https://evil.example.com/x',
      'https://hubspot-webhooks-journal.evil.com/x',
      'https://other-bucket.s3.amazonaws.com/x',
      'https://user:pw@hubspot-webhooks-journal-na1.s3.amazonaws.com/x',
      'https://hc-ping.com/x',
      'not a url',
    ])
      await assert.rejects(downloadJournalFile(bad), DownloadRejectedError, bad);
    assert.equal(calls, 0, 'never fetched');

    assert.equal(await downloadJournalFile(ok), '{"offset":"o"}');
    respond = () => new Response('x'.repeat(JOURNAL_MAX_FILE_BYTES + 1));
    await assert.rejects(downloadJournalFile(ok), DownloadRejectedError);
    let n = 0;
    respond = () => (n++ === 0 ? new Response('', { status: 503 }) : new Response('{}'));
    assert.equal(await downloadJournalFile(ok), '{}');
    respond = () => new Response('', { status: 403 });
    await assert.rejects(downloadJournalFile(ok), (e) => e instanceof HubSpotError && e.kind === 'refused');
  } finally {
    globalThis.fetch = real;
  }
});
