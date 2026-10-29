# L3e scan audit

The lane uses project `pt4bafablesq`, ports `632xx`, and a database limited to 0.5 CPU on the mini.
The backup and fixture corpus stay inside `lanes/fable-l3e`.
The database network fence rejects external HTTP.
Native cron stays disabled during replay.

## Setup

Cherry-picked `989c8522` as `2c64c717` for the configured replay port.
The replay-prefix unit test passed all three cases on Node 22.
`tests/db/l3e-scans.mjs` restores the production-shaped backup and holds the isolated stack for scan measurements.
Create the lane's `finish` marker to collect statistics and stop the stack.

## Results

The first restore failed with the database container marked `oomKilled=true`.
The retry allows 2 GiB during restore, then uses 1 GiB for measurements.
Backup transfer must finish before setup starts.
The third setup completed at 22:01 UTC after a Docker daemon disconnect invalidated two service containers on the second setup.
The failed stacks stopped with no cleanup errors.
The restored backup has 245,097 stats rows, 2,618 players, 3,817 season totals, and 241 roster rows.
It predates populated work history, cron history, and forecast caches.
Those three targets need replay or explicit shape preparation before a comparison.

### Rejected: missing-final-stats anti-join

Five interleaved pairs per season compared the existing anti-join with an `OFFSET 0` subquery.
Results matched for 2025, 2026, and an absent season.
Both versions already use stats indexes and read zero rows by sequential scan.
The 2026 median was 1.079 ms before and 0.910 ms after, with overlapping ranges.
The 2025 median was 1.001 ms before and 0.951 ms after.
The rewrite is discarded because it does not remove a reproduced scan or establish a gain beyond noise.
No index drops are proposed.
Constraint indexes will remain intact.

### Kept: projection player selection

File: `supabase/sql/functions/by-name/public/get_league_projection_rows.sql`.
This shared screen and forecast function separates the NULL player-list branch from the indexed ID-list branch.
The existing generic plan can skip the unbounded branch when IDs are supplied.
No index is added.

Five interleaved pairs compared complete returned rows in today, week-average, and week-total modes.
Each today sample repeats 50 calls; each weekly sample repeats 10 calls.
All 50 result fingerprints matched.
Raw samples, nested plans, and summaries are in the mini lane's `projection-players-full-*` artifacts.

| Case | Before median ms | After median ms | Before / after sequential player rows per call |
| --- | ---: | ---: | ---: |
| 20 IDs, today | 2.858 | 3.173 | 2618 / 0 |
| Empty IDs | 0.527 | 0.351 | 2618 / 0 |
| Unbounded today | 59.412 | 31.987 | 2618 / 2618 |
| 20 IDs, week average | 4.646 | 4.295 | 2618 / 0 |
| 20 IDs, week total | 2.234 | 4.423 | 2618 / 0 |

The unbounded call improves 46.2%; its ranges do not overlap: 57.974–61.878 ms before and 30.458–33.496 ms after.
The bounded cases eliminate the player scan; their timing ranges overlap.
The bounded today call reads 621 indexed rows across the measured targets instead of 2,618 sequential and 38 indexed rows.
The candidate reads more season totals than the old bounded plan, so a narrower averages branch is the next experiment.
No bounded CPU improvement is claimed from this round.
The NULL-list call still needs the complete player set to rank its results.
Function-source parity and targeted lint pass.

### Kept: bounded projection averages

File: `supabase/sql/functions/by-name/public/get_league_projection_rows.sql`.
The averages source now has separate NULL-list and indexed ID-list branches too.
This prevents the bounded player plan from fetching every season total.
Five interleaved pairs of 50 calls per sample preserve complete result bytes in all five cases.
The bounded call fetches 58 measured target rows instead of 621, a deterministic 90.7% reduction from the prior kept change.
That is 97.8% fewer target rows than the original 2,618 sequential plus 38 indexed rows.
Week-average median time falls from 3.707 to 2.549 ms, with overlapping ranges.
Unbounded median time is 34.091 / 31.910 ms in this incremental round.
Empty and week-total timings remain within noise.
The keep decision rests on the repeatable row reduction.
Evidence: `projection-averages-{samples,traces,summary}.json` in the mini lane.

### Kept: work retention index

The migration adds `private.work_items_retention(status,completed_at,id)` for succeeded and dead items.
The existing retention function stays unchanged.
This is an L4 bookkeeping overlap with one index and no function diff.
The shape has 3,757 rows, including 3,756 explicit synthetic completed items because the backup predates the queue history.

Five interleaved pairs compare no-expiry calls, with 100 calls per timing sample.
Five more pairs compare expired success, retained dead, and expired dead items.
Returned bytes and remaining table contents match.

| Case | Before median ms | After median ms | Before / after sequential rows |
| --- | ---: | ---: | ---: |
| No expired items | 0.925 | 0.078 | 3757 / 0 |
| Mixed expiry | 0.631 | 0.178 | 3760 / 0 |

No-expiry ranges are 0.551–0.972 / 0.076–0.095 ms.
The median improves 91.5% and removes the full scan.
Mixed-expiry ranges are 0.485–0.678 / 0.164–0.225 ms.
Evidence: `work-retention-{samples,traces,summary}.json` in the mini lane.
The final replay must still account for index maintenance during writes.

### Kept: work dashboard excludes completed history

File: `supabase/sql/functions/by-name/public/work_dashboard.sql`.
The join excludes succeeded items, which cannot contribute to any dashboard counter.
A partial covering index contains the other statuses.
This is an L4 bookkeeping overlap with one join predicate and one index.

Five interleaved pairs of 100 calls cover completed history and every counted state, including an expired lease and future work.
All 20 complete result fingerprints match.
The first fixture attempt hit active-payload uniqueness; distinct fixture payloads fixed the fixture before the measured run.

| Case | Before median ms | After median ms | Before / after sequential rows |
| --- | ---: | ---: | ---: |
| Completed history | 1.945 | 0.087 | 3757 / 0 |
| All work states | 1.556 | 0.101 | 3762 / 0 |

Completed-history ranges are 1.334–2.941 / 0.083–0.185 ms.
All-state ranges are 1.254–1.712 / 0.091–0.324 ms.
Both gains exceed the observed timing spread.
Evidence: `work-dashboard-{samples,traces,summary}.json` in the mini lane.

## Replay blockers and current validation

The first replay failed before workload execution because the copied full schedule contained future postponed games absent from the trimmed two-day game list.
The lane now preserves the copied schedule and filters its derived game list through October 24, matching the existing two-day game window.
The original failure is retained as `startup-failure-*` artifacts.

The next replay reached native workers but failed before creating the test league.
`api/trades/pick-values-work` exhausted three attempts with `Invalid predicted pick values or odds.`
`public.get_dynasty_pick_values` returns 2031 round-one bands of early 465.55, mid 320.35, and late 323.72 on the restored data.
`public.save_pick_predictions` only uses early and late as validation bounds.
The mid band lies below both bounds, so a valid weighted prediction can fail validation.
`tests/db/l3e-pick-band-audit.sql` reproduces this without changing data.
No prediction behavior is changed by this lane.
The failed run is retained as `pick-failure-*` artifacts.
A fresh restore is required before retrying, so dead work from the failed attempt cannot silently bypass the failing worker.

No game-night index-use claim or hourly replay gain is established yet.
No index drops are proposed.

App typecheck, test typecheck, full lint, and Knip pass.
The cherry-picked replay-prefix test needed an explicit test `NODE_ENV` for the repository's environment type.
The port, plan-parser, and chunk-parser tests pass all ten cases.
Full Vitest passes 4,712 tests, with 48 skipped, after the final grant and generated catalog updates.
The season harness unit suite passes all 346 tests.
The database season replay remains blocked before its first requested date.

## Further scan diagnosis

The chunked restore subsequently completed at 1 GiB, with the original 245,097 stats rows restored.
The chunk generator preserved all 290,940 tuple values and their ordered SHA-256.
The private empty-schema attestation generator also completed and stopped cleanly.
After updating generated attestations and the release-order section, full Vitest passes 4,712 tests with 48 skipped.
The season harness unit suite passes all 346 tests.

A native replay startup exposed eight costly import lock queries, totaling 379 ms.
Five interleaved pairs per import size compared an indexed UNION of lock candidates with the original OR predicate.
Complete outputs and player state matched for 1, 20, and 100 imported players; empty imports also matched.
The rewrite still read all 2,618 players because one name predicate lacked a matching expression index.
It is discarded.
The existing identity index stores the raw normalization expression.
The query calls `private.player_identity_name`, whose function configuration prevents that SQL function from being inlined to the indexed expression.
The next experiment adds an index on the actual function call.

### Kept: import identity function index

The migration adds `public.idx_players_identity_name_lookup` on `private.player_identity_name(display_name)` and analyzes the small players table.
The import function stays unchanged.
The existing raw-expression identity index stays intact.
This is an L4c overlap with one index and no function diff.

Five interleaved pairs per case preserve full output bytes and player state.
Every case eliminates the 2,618-row player scan.

| Import | Before median ms | After median ms | Before / after sequential rows |
| --- | ---: | ---: | ---: |
| One player | 13.946 | 1.061 | 2618 / 0 |
| 20 players | 20.803 | 8.650 | 2618 / 0 |
| 100 players | 98.142 | 88.855 | 2618 / 0 |
| Empty batch | 11.838 | 0.181 | 2618 / 0 |

The one-player ranges are 12.632–64.374 / 0.976–1.167 ms.
The 100-player ranges are 96.878–182.160 / 83.946–94.306 ms.
The empty-batch ranges are 11.450–12.742 / 0.151–0.188 ms.
Those cases improve beyond the measured timing spread.
The 20-player range has a quota outlier; its row reduction is consistent in all five pairs.
Evidence: `import-index-{samples,traces,summary}.json` in the mini lane.

### Rejected: point lookups for forecast history

The prepared shape has 241 history rows in 90,112 bytes, eleven heap pages.
Five interleaved pairs of 100 reads compare the hash-join scan with lateral primary-key lookups.
All complete result fingerprints match.
The rewrite replaces 241 sequential history rows with 50 indexed history rows.
Total query buffers rise from 223 to 362.
Median time is 5.993 / 6.160 ms, with overlapping ranges and a large candidate outlier.
The rewrite is discarded.
Evidence: `forecast-history-{samples,traces,summary}.json` in the mini lane.
A lineup notification probe for the selected live time returned no target scan; it does not explain the production roster rate.
The game-night replay is still needed to attribute that rate.

The direct service-role import recipe caught a required execution grant for the new function index.
`private.player_identity_name(text)` now grants execute to `service_role`.
Anonymous and authenticated roles remain unable to execute it.
The import function and normalization result stay unchanged.
The function catalog is regenerated from the private database after applying the grant.

## Final handoff

Five scan changes are kept after 160 paired cases across eight candidates.
Every retained query comparison matches the complete result fingerprint.
All existing indexes, including constraint indexes, remain intact.
Ship the final migration and generated catalogs together; the identity index requires the service-role grant in commit `4469b332`.
The direct service-role player-import SQL recipe and role-grant assertions pass on the private database.
Full lint, both typechecks, Knip, release-history checks, and function-source checks pass.

The only changed by-name files are:

- `supabase/sql/functions/by-name/public/get_league_projection_rows.sql`
- `supabase/sql/functions/by-name/public/work_dashboard.sql`
- `supabase/sql/functions/by-name/private/player_identity_name.sql`

The dashboard predicate and work-item indexes overlap L4 bookkeeping.
The identity index and helper grant overlap L4c imports.
There is no importer body change or forecast function change.

The full goal is incomplete.
The two-day replay completes zero of two dates because of the reproduced pick-value bounds failure.
No idle or live DB milliseconds per hour, full-night unused-index evidence, or attribution of 145 roster scans per minute is established.
No existing-index drops are proposed.
The backup has no work queue history; the measured queue fixtures contain 3,757 historical items.
Live write overhead of the new indexes remains unmeasured.

Resume with a fresh restore after resolving the pick-validation scope question.
Keep the `pick-failure-*`, `startup-failure-*`, and paired experiment artifacts in the private lane.
Do not repeat the 160 completed paired cases without a relevant source change.
Run `tests/db/l3e-replay.mjs` for the missing whole-workload evidence, then audit index use and hourly costs before proposing drops.

The private stack stopped at 22:59 UTC with cleanup true and no cleanup errors.
Its project containers and network are absent, its config is restored, and copied backups are removed.
The long standalone capture reached its 64 MiB SQL-log cap; it is not exhaustive workload evidence.
Each paired comparison retains its own complete trace and sample artifacts.
`standalone-after-snapshot.json` records partial index counters only.
The stats primary key, player/game unique key, and ID unique key back constraints and are excluded from drop proposals.
Zero counters for other indexes in this partial run do not establish that they are unused.
