# Pre-launch test plan

These tests run before real customers. Test #1 is done. Tests #2–#6 run on the production setup.

| # | Test | Why it matters | How | Status |
|---|---|---|---|---|
| 1 | Kill and restart the worker during a load run | No lost changes and no double stamps after a crash or deploy | Start a `mixed` load-test run, stop the worker mid-run, restart it after the lock goes stale (30 s), check the scorecard is 100% clean | **PASS** (2026-11-01) |
| 2 | Soak: 2–3 hours of steady traffic | Memory growth, pruning, token refresh (every 30 min), offsets over time | Loop small load-test runs (for example spread `--n 50` every 5 min) and watch `/health` and `/metrics` | To do |
| 3 | Two accounts at the same time | One busy customer must not slow another (per-account limits and fairness) | Install in a second test account; run a burst on account A and a spread on account B; compare B's latency | To do |
| 4 | Other change sources: CSV import and the workflow "associate records" action | HubSpot may log these differently from API and UI changes | Import a CSV with associations and labels; build a workflow that associates records; check the change log and stamps | To do |
| 5 | Custom objects under load | Bursts on a custom-object pair (for example a custom object ↔ Contact) | Watch a custom pair in settings; point the load test at that pair | To do |
| 6 | Workflow enrollments under load | Stamps are measured, but workflows must actually enroll each time | After a load run, spot-check a test workflow's enrollment history (count = expected changes after coalescing) | To do |

The load-test tool is `tools/src/load-test.ts` (see the tools package README). Results go into [kpis.md](kpis.md).

## Results

### Test #1: kill and restart the worker during a load run (2026-11-01): PASS

**Setup:**
- Worker only, current code. Load test `mixed --yes --append-kpis` at defaults: 440 association operations and 420 changes per run (a burst of 220 on one deal, plus a spread of 200 over 100 deals).
- For the graceful stop, the worker ran inside a small test-only wrapper that triggers SIGINT on demand. Windows can't send SIGINT to a background console process: `taskkill` without `/F` doesn't reach it.
- The hard kill was `taskkill /F` on the worker's process. A helper fired it as soon as the worker logged its first read with changes, so the kill landed in the middle of the burst.

| Run | Variant | Stopped for | Restart → caught up | Correct | Wrong labels | Missed | Duplicate stamps | Duplicate change-log rows |
|---|---|---|---|---|---|---|---|---|
| 1 | Baseline, no kill | n/a | n/a | 420/420 | 0 | 0 | 0 of 410 writes | 0 |
| 2 | Hard kill, 3 s after a busy read (queue empty) | 62 s | read in 5.7 s, queue drained in 12 s | 420/420 | 0 | 0 | 0 of 204 | 0 |
| 3 | Hard kill, right after a read, with 1 stamp queued | 49 s | read in 3.3 s, drained in 11 s | 420/420 | 0 | 0 | 0 of 203 | 0 |
| 4 | Graceful SIGINT, right after a read | 23 s | read in 3.8 s, drained in 10 s | 420/420 | 0 | 0 | 0 of 203 | 0 |

How the table was measured:
- "Restart → caught up" counts from the worker's `started` log line. Process boot before that line adds about 7 s.
- Every run also passed the labels check: final "current labels" matched HubSpot on 101/101 records.

**Checks:**

| Check | Result |
|---|---|
| Correctness 100% (every change in the change log) | **PASS**, 4/4 runs |
| Wrong labels = 0 (20/20 "Influencer → Decision maker" every run) | **PASS** |
| Missed stamps = 0 (final stamp = last change on all 101 deals) | **PASS** |
| No change ID written twice in `changecatch_last_change_id` history | **PASS**: 0 duplicates. Checked on the burst deal and all 100 spread deals in each run, via `propertiesWithHistory`. |
| No duplicate change-log rows for the same action | **PASS**: 0 groups. Grouped by object, other record, type, `occurredAt` and labels since each run's start. |
| Offset resumes from the last saved batch | **PASS**: every restart logged `started; offset <offset of the last completed read>`. |
| Queued stamps survive a crash | **PASS**: run 3 restarted with `1 stamp(s) queued`. In run 4 the queued stamp was written after the restart and appears once in the history. |
| Graceful stop | **PASS**: SIGINT stopped the worker in about 1 ms between batches. It logged "stopped; offset …, 1 stamp(s) left in the queue". The lock row was released, so the restart didn't wait 30 s. |
| Lock after a hard kill | **PASS**: restarting 40–55 s after the kill was accepted (the lock goes stale after 30 s). |

**Notes:**
- In runs 2–4 the latency KPIs show FAIL/WARN (p95 74 s, 52 s and 28 s). That is the planned downtime, not a defect.
- **Gap: the kill never landed mid-batch** (between a journal read and its offset commit). Each batch takes well under 1 s, so neither kill hit that window. The "re-read after a crash, de-dupe by `seen_events`" path wasn't exercised live; it is covered by unit tests. To force it, add a test-only delay before the offset commit and kill inside it.
- **Open observation (no loss):** the read logs said "66 held for pairing", yet `pending_pairs` was empty at both stops. All 20 label changes were still correct in every run, so the held entries were resolved before the stop. Worth checking whether that log count means what it says.
