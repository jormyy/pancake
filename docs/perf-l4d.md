# L4d background database cost

Baseline: ec739102. Lane: climb/l4d-gameday.
The private mini stack is pt4bafablegd on 631xx.
Postgres has a 0.5 CPU quota and 1 GiB memory.
The full production-shaped backup has 245,097 stats rows, 8,430 games, one league and ten enabled members.
The pinned corpus was copied into the lane fixture folder.
No production service was contacted.

The backup data SHA256 is d5a70e6155dff068c5973850faacf0cdf24d84f699c183f2f4798cfda7b2bd2e.
The restore splits INSERT statements into 500-row batches without changing rows.
Its SHA256 is 37d3820656314f1a2ea0ad0811a7444ccdafb6f3dc209d15c87f6dcdfa595f4c.
The first unchunked restore exceeded memory. It was discarded.
The first measurement after lowering the memory limit lost its connection. It was discarded.

## Per-job inventory

Calls per day use the supplied October 29 production inventory.
The backup itself ends at October 27 22:18 UTC. Its last day has 12 optimizer calls, 79 trade calls and one each for waivers, schedule and season boundary.
It predates the SQL work-item history. No production query was made.

DB ms are top-level pg_stat_statements execution deltas. Statement counts include PostgREST bookkeeping.
The optimizer, schedule and pick rows use interleaved paired evidence.
Other rows are five warm observations before and after, with unchanged code. Their differences are not accepted gains.

| Job | Calls/day | Before DB ms/run | After DB ms/run | SQL calls before → after | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| lineup-optimizer | 10 | 383.635 | 245.855 | 339 → 263 | Kept. 35.91% less DB time. |
| pre-tipoff | 6 | 103.980 | 89.939 | 72 → 72 | Retry repair. No load reduction claimed. |
| process-trades | 26 | 1.415 | 1.361 | 8 → 8 | No due trades. Shortcut rejected. |
| process-waivers | 1 | 1.578 | 1.574 | 8 → 8 | Existing bounded due-claim drain. |
| trade-publication | 7 | 0.497 | 0.491 | 1 → 1 | Already-consumed publication path. |
| trade-estimate | 4 | 0.022 | 0.024 | 2 → 2 | Existing quote already attached. |
| trade-activation | 1 | 0.026 | 0.024 | 2 → 2 | No drafting activation due. |
| pick-predictions | 1 | 79.423 | 162.581 | 10 → 14 | Repair. Before rejects; after saves 150 picks. |
| mock-room-expiry | 1 | 2.098 | 2.067 | 1 → 1 | Existing expiry scan. |
| sync-schedule | 1 | 135.950 | 69.826 | 6 → 6 | Kept. 48.64% less DB time; retry repair. |
| daily-stat-corrections | 1 | 0.922 | 0.961 | 1 → 1 | Range job already queued. |
| missing-final-stats | 1 | 6.900 | 7.523 | 1 → 1 | Existing bounded reconciliation. |
| retention-prune | 1 | 19.010 | 18.017 | 1 → 1 | Existing bounded prune; retained rows differ. |
| season-boundary | 1 | 0.454 | 0.384 | 12 → 12 | No boundary transition due. |
| sync-trade-values | 1 | 1.022 | 0.858 | 8 → 8 | Cached daily attempt path. |

The source-present pick row completes work that the old guard rejected. It is not a speed comparison.
The publication and activation observations cover no-op payloads available on this backup. Active mutation paths are correctness cases, not measured cost claims.
Cold observations are single samples. The initial source publication took 24.146 DB ms; later sync-trade-values probes took the cached path.
The first retention sample took 210.706 DB ms and removed retained logs and projections. Later samples did less work.
All new source fetches used the retained OneNumber fixture. Schedule inputs came from the backup calendar.
These are private Micro-budget measurements, not production latency claims.

## Method

Each comparison alternates AB and BA over five rounds after a warm-up pair.
Each context sample averages ten complete calls over all ten enabled members.
The threshold is the larger of the baseline range and 10% of its median.
A gain also requires output hashes to match and p95 to improve or stay level.
Raw evidence stays in ~/pancake-t_4ba51e0d/lanes/fable-l4d/ on the mini.
The benchmark is tests/performance/l4d-sql.mjs.

## Kept rounds

| Round | Work | Before median / p95 / range, ms | After median / p95 / range, ms | Gain | Evidence |
| --- | --- | --- | --- | --- | --- |
| 2 | Scheduled lineup optimizer | 383.6351 / 401.1009 / 76.7072 | 245.8551 / 257.5996 / 69.9333 | 35.91% | round2-lineup.json |
| 6 | Full sync-schedule job | 135.9495 / 145.1125 / 21.8141 | 69.8262 / 118.1824 / 52.0957 | 48.64% | round6-schedule-job.json |

The scheduled optimizer loads projections once per league and date in bounded batches.
Each member still reads its current roster and stored lineup and uses the same write guards.
A newly acquired player missing from the batch gets a fresh read.
Failed batch reads are retried by the next member.
Manual and pre-tipoff projection reads stay on their existing paths.
Database statement calls fall from 339 to 263 per run.
All measured weekly_lineups hashes and response bodies match.
Both variants report the same pre-existing PA004 trade-lock failure for one member.
That guard remains intact.

Schedule upserts retain the stored ID when the provider game already exists.
This uses the existing identity guard's known-ID path.
Every statement guard and identity-change guard still executes.
New games still get a database-generated UUID.
The changed RPC is public.publish_nba_schedule_atomic(integer,jsonb,jsonb).

## Rejected rounds

Round 1 deduplicated player lock reads within the pre-tipoff context RPC.
The isolated ten-member context fell from 38.0297 to 22.9890 ms with identical output.
The final full-job follow-up measured 96.4938 to 80.2560 ms, below the 38.029566 ms noise threshold.
The candidate was reverted after that follow-up.
Evidence: round1-context.json and round1-tipoff-job.json.

Round 3 tested returning early when no accepted trades are due.
The isolated RPC fell from 0.087703 to 0.023298 ms with equal output.
The full process-trades comparison did not clear its 71.91196 ms noise threshold.
Its measured medians were 9.492799 and 76.613402 ms after function replacement.
Function replacement invalidates plans and this small path was noisy under the quota.
The maximum isolated saving is only about 0.0644 ms per job.
The change was reverted.
Evidence: round3-trades.json and round3-trades-job.json.

Round 4 tested set-based schedule identity validation with every guard retained.
The SQL workload fell from 160.1044 to 140.3334 ms. Stored games, weeks and stat-week hashes matched.
The full sync-schedule comparison did not clear its 65.554457 ms noise threshold.
Its medians were 124.648501 and 128.171437 ms.
The change was reverted.
Evidence: round4-schedule.json and round4-schedule-job.json.

## Failure investigation

The backup predates private.work_items. It has no last-24-hour work errors.
Its sync_runs record three pre-tipoff failures on October 26–27 from request or database statement timeouts.
The current pre-tipoff worker did not retry SQLSTATE 57014 or the backup's FetchError timeout form.
It now uses its existing five-attempt budget for those transient errors.
Each retry rereads context and projections and checks the work lease.
The tipoff deadline, claim token and mutation guards are unchanged.

Schedule publication raises PT409 while another worker holds the season source lock.
The Edge worker previously failed immediately.
It now retries transient publication failures at most three times and checks the work lease around backoff.
Permanent calendar and identity errors still fail immediately.

Round 5 used five interleaved pairs per job on the private stack.
A real 220 ms shared source lock caused five baseline schedule failures and five candidate successes.
An injected PostgreSQL 57014 on the first lineup apply caused five baseline tipoff failures and five candidate successes.
All stored game and lineup hashes matched.
Evidence: round5-failure-recovery.json.
The first pilot lacked a normal tipoff warm-up and failed stored parity. Its log is retained separately.
The corrected run primes the normal result before both variants.
The exact October 29 work-item errors are absent from the supplied backup. These are path reproductions.

## Pick prediction recovery

The retained source exposed non-monotonic distant tier bands.
One row had early 465.55, mid 320.35 and late 323.72.
The existing model produced a valid weighted blend below the late tier.
The save guard incorrectly bounded values using only early and late.
It now checks the minimum and maximum of all three supplied tiers.
The prediction algorithm and serialized row payload are unchanged.
Source, type, odds-sum and value-bound checks remain active.
The changed RPC is public.save_pick_predictions(uuid,jsonb,text).

Round 7 had five interleaved baseline failures and five candidate successes, each saving 150 predictions.
The SQL regression recipe covers both directions of non-monotonic middle tiers and rejects invalid bounds, odds, types and sources.
Evidence: round7-pick-job.json and tests/db/l4d-pick-bounds.sql.
This is a correctness repair. No DB saving is claimed for completing previously rejected work.

## Checks so far

The evaluator rejected wrong-output and deliberately slow controls.
The pre-tipoff SQL guard recipe passes as postgres on the private stack.
The timeout and schedule tests pass: 27 tests. Their baseline run had 18 passes and 8 failures before the fixes.
A further lost-lease control passes after the fix.
The replay prefix tests pass: 3 tests.
The projection batching tests pass: 3 tests, including the 1,000-row boundary and failed-batch recovery.
Both typechecks, Edge typechecking, SQL source parity and lint pass.
The shared calendar, schedule no-op write gate and calendar completeness SQL recipes pass on the private stack.
The first full Vitest run had 3,883 passes, 820 failures and 48 skips.
Its six failing files required generated migration attestations and the current release-order migration number.
The subsequent complete run passed 4,705 tests with 48 skips.
The complete run after the pick repair also passed 4,705 tests with 48 skips.
The owned Edge suite passed 74 tests with 4 ignored.
Lint, app and test typechecks, dead-code checks, SQL source parity and generated attestation checks pass.
The final replay is blocked before its first date.
The baseline realtime-probe assertion expects six publication tables when matchups is absent.
The stack has sixteen tables and lacks draft_room_members.
The same assertion is present at base ec739102 in scripts/season-sim/realtime-probe.mjs:10.
Neither retained migration function changes the publication.
Repair requires L1 publication alignment or a harness logic change, outside the lane grant.
No assertion or publication was changed. Done-test: fail.

The first replay pilot stopped on a future makeup outside the selected two-day window.
The lane schedule index now excludes four future postponements outside October 24.
Every fixture entry inside the replay window is unchanged. Raw corpus files and hashes are unchanged.
Evidence: window-fixture-receipt.json. No harness logic was edited.


## Handoff

Application code is verified through ee25d6f2. Later commits contain generated attestations and this report.
The final local tree is committed. Every commit uses [skip ci]. No push, PR, CI or deployment ran.

Passed commands:

- Node 22: npx vitest run --maxWorkers=2. 4,705 passed, 48 skipped.
- Deno: the lineup, schedule, trade and waiver workers plus pick and estimate API worker tests. 74 passed, 4 ignored.
- npm run lint:all, npm run typecheck, npm run typecheck:tests and npm run check:dead-code.
- npm run check:db-function-sources and the generated release-attestation check.
- Private SQL recipes: shared-nba-calendar, excellence-schedule-write-gate, excellence-calendar-completeness and l4d-pick-bounds.

The replay reached origin startup after configuring the two-day fixture index and restarting the lane auth pool after clock installation.
It then failed the unchanged realtime publication assertion. Zero of two dates completed.
Evidence: season-final.log, evidence/replay-checkpoint.json and replay-blocker.json in the mini lane.
The exact October 29 production last_error strings remain unavailable; timeout and source-lock fixes use reproduced failing paths.

The private stack is stopped. Its clock was restored before shutdown.
The stack cleanup receipt reports success with no errors.
Copied backup SQL, compressed data, database dumps and replay snapshots were deleted.
The pinned corpus, benchmark runners and aggregate evidence remain in the lane folder.

Resolve the L1/harness publication contract, then rerun the season replay from a private restored stack.
Do not repeat the discarded context, empty-trade or set-based identity candidates without new evidence.
The local unit, lint, type and SQL checks need no repeat unless code changes.
