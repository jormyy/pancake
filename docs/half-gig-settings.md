# Half-gig database cuts

These changes reduce stored history, repeated trigger calls, and duplicate index writes.
They do not establish the 95% swap target.
The separate game-night measurement owns that result.

## Migration changes

| Cut | Before | After | Expected jobs per hour |
| --- | --- | --- | --- |
| Duplicate game-time index | Two identical indexes on `nba_games(game_time)` | Keep `idx_nba_games_game_time`; remove `idx_trade_game_time` | No change; one fewer index entry per insert or changed game time |
| Score revision triggers | Enter the row function on every update | Enter only when a score input changes | No change; zero score-trigger calls for clock, score-display, or minutes-only updates |
| Player-stat storage | Table rebuild loses all storage options | Fillfactor 90; vacuum after 50 + 2% dead rows; analyze after 25 + 2% changes | No worker changes; earlier vacuum bounds dead-row growth |
| Successful cron history | 24 hours | 6 hours; failures and orphan checks retain 24 hours | Existing hourly cleanup stays at 1 |
| Successful sync history | 7 days | 1 day; keep the newest success per function | Same hourly cleanup; no new job |
| Application broadcasts | Managed retention of about 3 days | 1 day for private `l1:` broadcasts | Same hourly cleanup; no new job |
| Scheduler transitions | No expiry | 7 days; current state and hint revision stay | Same hourly cleanup; no new job |

The migration changes no worker cadence.
Successful cron history should fall about 75% at a steady rate.
Successful sync history should fall about 86%, except retained newest results.
Expired broadcast rows should fall about 67% when cleanup keeps pace.
These are row-count estimates, not measured memory or swap savings.

Cleanup deletes at most 512 cron rows, 4,096 sync rows, 4,096 broadcasts, and 512 scheduler transitions per hour.
Large backlogs drain over several runs.
The job honors the pause switch and skips locked rows.
It uses an advisory transaction lock, a five-second statement limit, a 100 ms lock limit, and 2 MB work memory.
Errors remain errors and roll back that run.

Failures, unfinished sync work, and the newest successful result retain their existing protections.
Public broadcasts and other Realtime topics retain managed expiry.
The client uses broadcasts as change notices and does not request historical replay.
Deletion makes pages reusable; it does not immediately return all disk space or memory.
No table rewrite or manual vacuum runs during this migration.

## Index proof and retained indexes

The removed and retained indexes have equal keys, operator classes, sort rules, expressions, predicates, and uniqueness.
The migration checks that equality before removing the duplicate.

The clock query in `private.trade_revaluation_input_version` reads `max(game_time)` before the current time.
The notification clock in `private.complete_notification_scan_chunk` reads the next game time after two hours.
A disposable fixture contains 30,000 games.
Both queries return identical values after removal and use the retained index.
Each index scan reads one row; together they touch six cached blocks and use no temporary blocks.
The redundant fixture index occupies 688,128 bytes.
That figure describes the fixture, not production.

No player-stat index is an exact duplicate.
The repository's [captured index plans](../tests/db/unpartition-tables.md) use every older player-stat access index.
`lib/players.ts` still filters by player and season, then orders by date.
`sync-projections` still filters by season and week.
The scoring loader still filters by player, season, and date.
The forecast and trade history indexes serve their separate partial queries.
The global `id` constraint and composite primary key have different definitions.
They stay in place with the identity guard and replica identity.

## Trigger and storage review

Only the trigger definitions on `public.nba_games` and `public.player_game_stats` change.
`private.track_score_input_revision()` stays unchanged.
Inserts and deletes still enter it for each row.
Updates use its existing field list as the trigger condition.
Changing `stats_synced_at` between two non-null values remains irrelevant to score revisions.
Changes between null and non-null still invalidate score inputs.

Score revisions still publish at the existing transaction boundary.
This change does not batch distinct revision increments.
The existing hint, forecast, league-version, career-count, and player-total triggers already use statement-level change tables.
Their bodies stay unchanged.
`private.emit_league_change()`, `private.track_trade_input_revision()`, and `private.invalidate_forecast_inputs()` remain owned by their existing source files.

The player-stat rebuild leaves `reloptions` empty in the baseline.
The migration restores free page space for updates and earlier vacuum thresholds.
Existing pages acquire that space through ordinary maintenance; the change does not shrink them immediately.
`nba_games`, work items, score revisions, hint queues, and screen queues already have fillfactor 90 and bounded vacuum settings.
They retain those settings.
Managed cron and Realtime tables retain their service-owned storage settings.

## Hosted settings for Michael or Claude

Read current settings first.
Apply and measure one change at a time in the separate replay.
The values below are candidates, not settings applied by this migration.
Local `supabase/config.toml` does not change hosted service settings.

| Setting | Candidate | Expected memory effect | Apply outside migrations |
| --- | --- | --- | --- |
| PostgREST `db-pool` | Test 2 and 5 connections; keep idle expiry at 30 seconds | Bounds active SQL backends; savings depend on removed backends and their measured private memory | Management API `PATCH /v1/projects/{ref}/postgrest`, body `{"db_pool":2}`; this is separate from Supavisor's pool |
| `max_connections` | Test 40 after service pools fit below that limit | Lowers shared bookkeeping and prevents unbounded backend growth; unused slots do not equal running backends | Hosted Postgres configuration; restart required |
| `work_mem` | Keep 4 MB first; test 2 MB separately | Saves up to 2 MB per active sort; hash savings also depend on `hash_mem_multiplier` | Hosted Postgres configuration; compare temporary I/O and interactive latency |
| `shared_buffers` | Test 64 MB if the current value is 128 MB | Frees 64 MB of fixed shared allocation; can increase reads | Hosted Postgres configuration; restart required |
| `maintenance_work_mem` and `autovacuum_work_mem` | Test 16 MB each | Caps memory per maintenance task or vacuum worker; smaller limits can increase passes | Hosted Postgres configuration |
| Realtime SQL pools | Ask support which tenant pools can use 2 connections | Fewer idle database backends; savings require a lower actual connection count | Provider-managed configuration; no documented dashboard pool control |
| Realtime event and connection limits | Fit measured peak usage with headroom | Bounds fan-out memory on Realtime nodes; database savings are indirect | Realtime settings; preserve draft presence and private broadcasts |
| Realtime history | Keep managed partition cleanup enabled | Reclaims expired partitions after the application cleanup makes old rows reusable | Provider-managed cleanup; this migration never drops managed partitions |
| Optional services | Disable unused GraphQL, log drains, or analytics where the provider supports it | Usually removes little fixed Postgres memory; savings depend on actual requests and connections | Hosted service settings after checking callers |
| Local-only services | Studio, mail catcher, image proxy, analytics collector can be off in isolated test stacks | Frees local service memory; gives no automatic hosted Postgres saving | Local stack configuration only |

Keep Auth for login, Storage for avatars, Realtime for instant actions, and cron plus `pg_net` for current workers.
Do not disable required services to meet the memory target.
Do not shorten connection acquisition limits to hide a saturated pool.

The [PostgREST configuration endpoint](https://supabase.com/docs/reference/api/v1-update-postgrest-service-config) requires `rest:write` or `data_api_config_write` access.
It also accepts `db_pool_acquisition_timeout`; leave that value unchanged when testing pool size.
The local lab replaces only its own PostgREST container with the requested pool settings.
Local lifetime and idle-time experiments do not establish that hosted controls exist for those settings.
No hosted configuration changes occur in the lab.

For a measured `shared_buffers` change, the hosted command is `supabase postgres-config update --config shared_buffers=64MB --project-ref <ref> --experimental`.
The [Postgres configuration guide](https://supabase.com/docs/guides/database/custom-postgres-config) requires a restart for this setting.
Read the applied value and `pending_restart` afterward.
The lab uses its own container and never runs that hosted command.

[PostgREST pooling](https://docs.postgrest.org/en/stable/references/connection_pool.html) explains backend lifetime and queueing.
[Postgres memory settings](https://www.postgresql.org/docs/17/runtime-config-resource.html) distinguish shared memory from per-operation memory.
[Supabase configuration](https://supabase.com/docs/guides/database/custom-postgres-config) describes hosted updates and restarts.
[Realtime settings](https://supabase.com/docs/guides/realtime/settings) describe supported service limits.
[Realtime architecture](https://supabase.com/docs/guides/realtime/architecture) describes managed broadcast retention.

## Verification

The disposable database uses PostgreSQL 17.6 and the repository's complete migration sequence.
Auth, Storage, and Realtime use their matching public service schemas.
The new migration also applies with a non-superuser application owner and the required cron API grant.
No production database, backup, or credential file is used. The replay adds separate game-night evidence.

The supplied test selector reports this migration as unmapped.
The selected checks are:

| Check | Result |
| --- | --- |
| `tests/db/scheduler-health.sql` | Pass; 49 checks |
| `tests/db/live-player-stats-hints.sql` | Pass |
| `tests/db/calendar-live-marker.sql` | Pass |
| `tests/db/postponed-score-access.sql` | Pass; 10 checks |
| `tests/db/game-identity.sql` | Pass |
| `tests/db/retention-pruning.sql` | Pass; 21 checks |
| `tests/db/player-game-keyset.sql` | Pass; 9 checks |
| `tests/db/hygiene-indexes.sql` | Pass |
| `tests/db/statistics-freshness.sql` | Pass; 11 checks |
| `tests/db/score-finalization-idempotence.sql` | Pass |
| Live-save section of `tests/db/io-write-reductions.sql` | Pass; 5 checks |
| Direct score-trigger probe | Pass; 8 checks; restoring old triggers causes the check to fail |
| Direct hourly-retention probe | Pass; 13 checks; restoring the old job causes the check to fail |
| Direct clock-index probe | Pass; 3 checks; removing both indexes causes the check to fail |
| Migration guard | Pass; a different index definition causes migration failure before removal |
| SQL source parity and whitespace checks | Pass |

The trigger probe reduces two irrelevant-update calls to zero and preserves meaningful updates, inserts, and deletes.
The retention fixture starts with 4,200 old broadcasts and 4,200 old successful sync records.
The first run removes exactly 4,096 of each and finishes in 16–22 ms across the local probes.
The next run clears the eligible remainder.
Pause, failure, active-work, newest-result, other-topic, and current-health checks pass.
These are isolated fixture measurements, not game-night performance results.

The original unchanged-screen test fails at `e5f16211` before these cuts.
Its fixture captures trade inputs before initializing the averages that form part of those inputs.
The repaired fixture captures the completed initial state, then checks that identical content produces no writes.
It also uses a completed NBA game, expects the shared dispatcher, and clears its own pending scan inputs before testing idle work.

The old statistics test requires every table to be analyzed, even when its statistics are fresh.
The repaired test accepts fresh statistics and verifies that a second pass performs no analysis.

The reported 27 permission mismatches do not reproduce in fresh local stacks.
Both `e5f16211` and the current schema match existing ownership and permission entries.
The new cache invalidation trigger receives its missing catalog entry with owner-only execution.
No release attestation is regenerated.

The approved schedule passes `supabase/functions/refresh-views/schedule.test.sql` with 46 checks.
The new `tests/db/nightly-worker-hours.sql` covers all six deferred job kinds with 12 checks.
Before the fix, pick predictions start during a live game and fail that test.
After the fix, they remain pending until the nightly window.
A clock-driven live-worker test observes ticks at 0, 30, 60, and 90 seconds, then exits immediately on an idle slate.
The original 20-second worker fails the same test.

Run selected SQL files with `psql -X -v ON_ERROR_STOP=1 -f <file>` against a disposable database.
The lab runner supplies its own loopback port and translates test-only placeholder URLs to that stack.
Run `node scripts/check-db-function-sources.mjs --check` and `git diff --check` afterward.
Hosted settings and real game-night load remain unmeasured until a separate authorized rollout.
