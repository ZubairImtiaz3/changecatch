# Performance KPIs

**Measured:** 2026-10-30 and 2026-11-01, against a real HubSpot test account (Marketing Hub Enterprise trial). The worker ran on a developer laptop behind a dev tunnel, with one installed account. **Re-measure on the production host before publishing these numbers.**

Every test linked, relabeled and unlinked **existing** records through the HubSpot API. The worker then had to notice each change, work out what kind it was, and stamp it onto the record. Every link was removed afterwards. The load-test tool lives in the `tools` package (`tools/src/load-test.ts`).

## Headline numbers

| What we measured | Result | Target |
|---|---|---|
| Changes captured | **100%** in every run (up to 1,250 changes in one run) | 100% |
| Wrong labels written | **0** in every passing run | 0 |
| Missed stamps (record not showing its latest change) | **0** in every run | 0 |
| Time from change in HubSpot to stamped on the record, typical (p50) | **~8 s** at normal load; **~9 s** at 1,300 changes in about a minute | ≤ 10 s |
| Time from change to stamp, slowest 5% (p95) | **~10–12 s** at normal load; **~15 s** at peak test load | ≤ 20 s |
| Changes handled per second | **55/s sustained, 97/s peak** (one account) | — |
| Stamps written per minute | up to **~2,700/min** | — |
| HubSpot API calls per change | **~0.01–0.02** (stamps go 100 records per call) | — |
| Peak requests per 10 s for one account | **15** (HubSpot's limit is 110) | ≤ 100 |
| HubSpot errors (429 / 5xx) | **0** | 0 |
| Burst of changes on ONE record | **650 changes → 6 stamps** (108× fewer workflow runs) | fewer is better |
| Other records slowed down by a burst | **No**: burst and normal records had similar times | no slowdown |

## The scenarios

| Scenario | What it does | Result |
|---|---|---|
| Label churn | 10 links, each label flipped 5 times about 1 s apart | 100% correct; final labels all match HubSpot |
| Spread | 1 link each on 100 deals, then unlinked | 100% correct, p50 8.8 s, 747 stamps/min |
| Burst | 100 contacts on one deal + 20 label edits + unlink all | 100% correct; 220 changes → 6 stamps |
| Mixed | Burst + spread at the same time | 100% correct after the split-file fix; p50 8.1 s, p95 11.8 s |
| Big mixed | 300-contact burst + 300 deals + 50 label edits (1,300 operations) | **100% correct** (1,250/1,250 changes, 301/301 labels, 0 wrong, 0 missed); p50 9.1 s, p95 15.1 s; all drained ~12 s after the last change |

## Problems found by testing (all fixed)

1. **Slow when quiet.** The worker read the journal only every 1–2 minutes when idle. Fixed: it now polls every 3 s. One link went from 53 s to about 8 s.
2. **One action split across files.** Under load, HubSpot spreads the two halves of one action ("link removed" + "label removed") across several journal files, seconds apart. The first half was treated as the whole action. Fixed with a short hold for the missing half, plus recognising late halves of an action already handled (see [decisions.md](decisions.md), D6). It stays correct at any load and never misses a trigger.
3. **App approval on Enterprise accounts.** Some companies require a super admin to approve an app's extra permissions. Handled with a clear message and steps (see [user-guide.md](user-guide.md)).

## What this means for a customer

- A workflow on a ChangeCatch trigger usually starts **about 10 seconds** after someone links, unlinks or relabels a record, plus HubSpot's own workflow start time.
- Bulk changes (imports, many links at once) are captured completely. A record that changes many times in a burst triggers a **few** workflow runs, not hundreds.
- ChangeCatch uses a small share of the account's HubSpot API limit (under 15% even in the heaviest test).

## Run log

One row per load-test run. "Coalescing" is changes per stamp on the burst record.

| Date (UTC) | Scenario | Changes | Logged % | Final labels % | Wrong | Missed | Stamp p50 | p95 | p99 | Drain | Peak req/10s | 429/5xx | Coalescing | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-30 03:52 | label-churn | 70 | 100.0% | 100.0% | 0 | 0 | 10.4 s | 12.2 s | 12.2 s | 10.5 s | 9 | 0/0 | - | WARN |
| 2026-10-30 03:53 | spread-many-records | 200 | 100.0% | 100.0% | 0 | 0 | 8.8 s | 9.7 s | 9.7 s | 8.9 s | 9 | 0/0 | - | PASS |
| 2026-10-30 03:54 | burst-one-record | 220 | 100.0% | 100.0% | 0 | 0 | 7.9 s | 10.5 s | 10.7 s | 11.8 s | 6 | 0/0 | 36.67 | PASS |
| 2026-10-30 03:56 | mixed | 457 | 100.0% | 75.2% | 0 | 0 | 10.7 s | 13.9 s | 13.9 s | 14.0 s | 12 | 0/0 | 36.67 | FAIL |
| 2026-10-30 04:10 | mixed | 420 | 100.0% | 100.0% | 0 | 0 | 8.1 s | 11.8 s | 11.8 s | 14.6 s | 12 | 0/0 | 31.43 | PASS |
| 2026-10-30 04:12 | mixed | 1579 | 100.0% | 84.4% | 0 | 0 | 10.3 s | 20.3 s | 21.4 s | 19.2 s | 15 | 0/0 | 87.38 | FAIL |
| 2026-10-30 04:35 | mixed | 1311 | 100.0% | 100.0% | 7 | 0 | 9.1 s | 14.0 s | 14.9 s | 278.6 s | 15 | 0/0 | 173.75 | FAIL |
| 2026-10-30 05:00 | mixed | 1250 | 100.0% | 100.0% | 0 | 0 | 9.1 s | 15.1 s | 15.4 s | 11.8 s | 15 | 0/0 | 108.33 | PASS |
| 2026-11-01 01:42 | mixed | 420 | 100.0% | 100.0% | 0 | 0 | 8.3 s | 11.9 s | 11.9 s | 10.7 s | 12 | 0/0 | 36.67 | PASS |
| 2026-11-01 01:45 | mixed | 420 | 100.0% | 100.0% | 0 | 0 | 58.9 s | 73.6 s | 73.6 s | 74.1 s | 12 | 0/0 | 55.00 | FAIL* |
| 2026-11-01 01:49 | mixed | 420 | 100.0% | 100.0% | 0 | 0 | 37.6 s | 51.5 s | 51.5 s | 52.1 s | 12 | 0/0 | 73.33 | FAIL* |
| 2026-11-01 01:51 | mixed | 420 | 100.0% | 100.0% | 0 | 0 | 13.9 s | 28.3 s | 28.3 s | 30.3 s | 12 | 0/0 | 73.33 | WARN* |

Notes:
- The 10-30 FAIL rows led to the fixes above: 03:56 and 04:12 found the split-file problem (D6), and 04:35 found burst edge cases (relabel joins, superseded changes) that were fixed before the 05:00 run.
- \* The 11-01 rows are the kill-and-restart test (see [pre-launch-test-plan.md](pre-launch-test-plan.md), test #1). The worker was stopped on purpose mid-run, so the latency verdicts reflect planned downtime. Correctness was 100% in all four runs.
