# Live scoring and injury locks

## Blocking statements

`save_live_scoreboard_atomic` waits on the forecast-queue upsert held by the injury worker's batched `link_player_sources_atomic` call.

The scoreboard updates `nba_games`.
`emit_league_change` updates its league hint.
`queue_changed_matchup_forecasts` then calls `queue_matchup_forecasts`.
Its `INSERT INTO private.matchup_forecast_queue ... ON CONFLICT DO UPDATE` waits for the injury transaction.

The identity batch fills player position data.
That update queues the same matchup before the batch processes its next player.
The transaction holds that queue row until every identity finishes.

A second wait affects stat writes.
`save_live_game_stats_atomic` calls `save_game_stats_atomic`.
Its career trigger calls `recount_player_career_games`, whose `SELECT ... FOR UPDATE` waits for the injury status update on `players`.
The old trigger requests that lock when only points change.
The player's appearance count stays unchanged.

## Effective timeout

Migration `20261114000100_bounded_worker_database_work.sql` sets `service_role.lock_timeout` to `250ms`.
It also sets `statement_timeout` to `3s`.
PostgREST applies those role settings to Edge requests.
The regression test reads `current_user` and `current_setting('lock_timeout')` through PostgREST and confirms `service_role` and `250ms`.

## Changes

The injury worker links one identity per transaction.
It writes guarded injury status updates separately, in player ID order.

The career trigger recounts only changed appearances or changed player and game identities.
Point corrections with the same appearance state write stat lines without locking player rows.
First appearances, removed appearances, and identity changes still recount.

Live ingestion retries transient database failures within each tick.
It permits four retries and checks the work lease before each retry.
The existing tick deadline bounds those attempts.
`tickRetries` counts these retries separately from `scoreRetries`.
Permanent failures remain visible.
Final stat retries reuse captured work, so the attempt stamp cannot hide an unfinished game.

## Failure controls

The private stack uses project `pt4bafablelp` and ports `589xx`.
The test uses real worker functions and PostgREST with fixed provider responses.
It creates two players, one game, one league, and one matchup.
It removes every fixture afterward.
An advisory barrier orders the two transactions without replacing their writes.

| Control | Result | Lock evidence |
| --- | --- | --- |
| Restore the old identity batch | Fails during scoreboard publication | `pg_stat_activity` identifies `link_player_sources_atomic` as the blocker. `pg_locks` records a transaction `ShareLock` wait. |
| Restore the old career trigger | Fails during stat publication | The database reports `while locking tuple ... in relation players`, inside `recount_player_career_games`. |
| Remove scoreboard retry handling | Fails on one injected `55P03` | The original worker returns the database failure. |

The scoreboard control's database stack records `queue_matchup_forecasts`, `queue_changed_matchup_forecasts`, `emit_league_change`, and `save_live_scoreboard_atomic`.
This reproduces the uncaught tick failure path from the replay.

## Passing evidence

The final test passes one identity overlap and 20 consecutive injury status overlaps.
Each run checks stat counts, player counts, injury values, career counts, and both matchup scores.
It checks every database response for lock timeouts.
It also checks both retry counters and samples database lock waits.

| Timeout | Overlaps | Stat lines | Injury updates | Matchup publications | Lock timeouts | Observed lock waits | Retries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 ms | 21 | 42 | 42 | 21 | 0 | 0 | 0 |
| 5 ms | 21 | 42 | 42 | 21 | 0 | 0 | 0 |

The strict run temporarily sets the service role timeout to `5ms`.
It confirms that value through PostgREST before starting.
It restores `250ms` during cleanup.

Other checks pass:

| Check | Result |
| --- | --- |
| Affected Vitest tests | 739 pass |
| Full Vitest suite | 4160 pass, 47 skipped |
| Core season tests | 6 pass |
| Live-poll, injury, and shared retry Deno tests | 53 pass |
| Season simulator tests | 314 pass |
| Season boundary Deno tests | 19 pass |
| Career, appearance, regular-season, base, live-poll queue, and three-season database recipes | 6 pass |
| `npm run check:quality` | Pass |
| Function catalog, database types, and migration attestations | Pass |

The database regression runs separately from the default Edge tests.
The default run reports that database test as ignored.

## Repeat the concurrency check

Run these commands in the private mini checkout with its stack running.

```sh
export PATH=$HOME/pancake-local/tools:$PATH
export DOCKER_HOST=unix://$HOME/pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock
PANCAKE_LIVE_LOCK_DB_TESTS=1 deno test --no-lock --allow-env --allow-read --allow-net=127.0.0.1 --allow-run=psql,supabase supabase/functions/live-poll/contention.test.ts
PANCAKE_LIVE_LOCK_DB_TESTS=1 PANCAKE_LIVE_LOCK_STRICT=1 deno test --no-lock --allow-env --allow-read --allow-net=127.0.0.1 --allow-run=psql,supabase supabase/functions/live-poll/contention.test.ts
```

## Changed files

| Files | Purpose |
| --- | --- |
| `supabase/functions/live-poll/runner.ts` | Retry tick writes and report retry counts. |
| `supabase/functions/_shared/databaseRetry.ts` | Bound database retries and preserve lease checks. |
| `supabase/functions/sync-players/injuries.ts` | Link one identity per transaction and share retry handling. |
| `supabase/sql/functions/by-name/private/recount_changed_player_careers.sql` | Recount changed appearances only. |
| `supabase/migrations/20261128000100_live_poll_injury_contention.sql` | Apply the canonical trigger function. |
| `supabase/functions/live-poll/contention.test.ts` | Prove both write paths under ordered contention. |
| `supabase/functions/live-poll/runner.test.ts` | Check tick, scoreboard, and final stat retries. |
| `supabase/functions/_shared/databaseRetry.test.ts` | Check transient failures, deadlines, and lease loss. |
| `supabase/functions/sync-player-injuries/index.test.ts` | Check separate identity transactions and guarded status updates. |
| `tests/e2e/release-history-attestations.json` | Record the generated migration attestation. |
| `tests/e2e/db-security-catalog-attestations.json` | Record the generated security attestation. |

## Other verification commands

Run Vitest, lint, and TypeScript checks with Node 22 on the Mac.
Run database and Edge tests on the mini.
The full Vitest suite runs on the mini to keep memory use off the Mac.

```sh
npx vitest run tests/edge-function-inventory.test.ts tests/e2e-injury-function-contract.test.ts tests/db-function-source-parity.test.ts tests/release-history-attestations.test.ts tests/e2e-attestation-head.test.ts tests/db-security-catalog-contract.test.ts tests/season-sim-cron.test.ts tests/lib/season.test.ts tests/lib/live-player-stats.test.ts tests/lib/player-season-averages.test.ts tests/hooks/live-stats-polling.test.ts
npx vitest run --config core/vitest.config.ts core/tests/season.test.ts
npm run check:quality
npx vitest run
deno test --no-lock --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions/live-poll supabase/functions/sync-player-injuries supabase/functions/_shared/databaseRetry.test.ts
node --test scripts/season-sim/*.test.mjs
deno test --no-lock --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions/_shared/seasonBoundary*.test.ts
```

The database recipes use `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:58922/postgres`.
Each recipe runs through `psql` with `-X -qAt -v ON_ERROR_STOP=1 -f`.

```text
tests/db/player-data-career.sql
tests/db/player-data-appearances.sql
tests/db/player-data-regular-season.sql
tests/db/player-data-base-regressions.sql
tests/db/work-queue-live-poll.sql
tests/db/three-season-simulation.sql
```

The generator and catalog checks also use `PANCAKE_TEST_DB_PORT=58922`.

```sh
npm run generate:db-function-catalog
node scripts/regenerate-release-history-attestations.mjs
npm run generate:database-types
npm run generate:edge-shared
npm run check:db-function-catalog
npm run check:database-types
node scripts/regenerate-release-history-attestations.mjs --check
```

Mini evidence remains beside the private checkout.
`contention-batch-control.log`, `contention-career-control.log`, and `retry-before.log` record the failure controls.
`contention-final.log` and `contention-strict.log` record the passing database checks.
`edge-tests.log`, `season-tests.log`, `season-edge-tests.log`, `db-regressions.log`, and `vitest-full.log` record the other tests.
