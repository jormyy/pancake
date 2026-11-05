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

## Verification

Use an isolated local stack with the project's Edge functions.
The contention recipe checks identity writes, injury writes, score publication, and retry limits.
Its negative controls restore the old identity batch and career trigger.

```sh
PANCAKE_LIVE_LOCK_DB_TESTS=1 deno test --no-lock --allow-env --allow-read --allow-net=127.0.0.1 --allow-run=psql,supabase supabase/functions/live-poll/contention.test.ts
```

Set `PANCAKE_LIVE_LOCK_STRICT=1` to repeat at a five-millisecond lock timeout.
The recipe restores the normal timeout during cleanup.
See [verification](verification.md#local-stack) for local setup.
