# Background schedule changes

The migration moves repeated background work out of game hours. These rates are expected bounds, not measured swap gains.

| Work | Before | After |
| --- | --- | --- |
| Dispatcher and hint-drain cron | 120 starts/hour combined | 60 starts/hour combined; one database session handles both |
| Saved-screen refresh | Up to 60/season/hour, plus a separate live-matchup pass | At most 30/season/hour; one coalesced path |
| Forecast inputs and win odds | Triggered by score changes and expiry | At most 2/matchup/hour during games, plus a final update |
| Forecasts outside games | Expiry and input changes cause work | No computation; final odds stay valid |
| Screen and forecast-input edge workers | Separate worker invocations | Zero; the dispatcher does their SQL work directly |
| Standings | Checked during every screen refresh | Initial fill, relevant setup changes, and completed weekly matchups |
| Season totals and averages | Every live stat change; approximately 180 ticks/hour at a 20-second feed | Zero live ticks; game completion and final-stat corrections |
| Trade re-analysis scans | Up to 60/season/hour from screen refreshes | Once nightly, plus analysis when each trade is created |
| Individual trade re-analysis | Up to 6/trade/hour during games | Once nightly; failed attempts remain retryable |
| Injuries before the pregame window | Up to 4/hour after 11 a.m. | 1/hour on game days |
| Injuries from two hours before first tipoff through last tipoff | 4/hour | 4/hour |
| Injuries after last tipoff | Hourly | Zero until the next day's window |
| Injuries on off days | Multiple hourly runs | 1/day |
| Sleeper projections | Three daily windows plus the weekly pull | Morning and one hour before first tipoff |
| FantasyPros projections | Morning and fixed afternoon time | Morning and one hour before first tipoff |
| Rankings | Three views weekly | Three views nightly, as requested |
| Player details and trade values | Daily jobs can catch up during games | Overnight only, between 04:00 and 06:00 Eastern; defer if games still run |

Cached screen work and forecast inputs share the existing dispatcher connection. The migration removes the second saved-matchup queue producer. Direct trade offer submission, pre-tipoff work, draft timing, and waiver paths retain their existing routes.

# Verification

The final migration applies successfully to a disposable PostgreSQL 17 database with the repository's baseline migrations and empty platform schemas. No production database, backup, or game-night lab is used.

Nine SQL test files pass. The new schedule test contains 46 assertions. Seven existing forecast computation tests pass. Canonical SQL source parity and whitespace checks pass.

The old injury scheduler fails the off-day control: three hourly calls create three jobs, where the new test requires one. The new schedule passes this control.

The test selector reports every changed SQL file as unmapped. These tests cover the changes instead:

- `supabase/functions/refresh-views/schedule.test.sql`
- `tests/db/refresh-player-averages.sql`
- `tests/db/work-lease-phases.sql`
- `tests/db/work-queue-pre-tipoff.sql`
- `tests/db/work-queue-weekly-scoring.sql`
- `tests/db/work-queue-trades.sql`
- `tests/db/trade-offer-retries.sql`
- `tests/db/continuous-faab-schedule.sql`
- `tests/db/draft-timer-behavior.sql`
- `supabase/functions/matchup-forecast/compute.test.ts`

Commands, with database URLs restricted to the disposable loopback database:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261214006300_schedule_half_gig.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/functions/refresh-views/schedule.test.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/refresh-player-averages.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/work-lease-phases.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/work-queue-pre-tipoff.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/work-queue-weekly-scoring.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/work-queue-trades.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-offer-retries.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/continuous-faab-schedule.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/draft-timer-behavior.sql
deno test --no-lock --node-modules-dir=none --allow-read supabase/functions/matchup-forecast/compute.test.ts
node scripts/check-db-function-sources.mjs --check
git diff --check
```

The host's older psql does not support `\getenv`. For two existing tests, the runner substitutes the supplied loopback values in memory before execution. It does not edit those test files.

The broader catalog check fails on 27 ACL differences in unchanged functions. For example, the local `get_matchup_forecast` grants service-role execution while the manifest omits that grant. This migration changes none of those grants. All function definitions match after restoring the baseline definitions used during iteration. No release manifest or attestation changes.

Swap, production behavior, and HTTP service integration remain unmeasured. The full suite and the separate game-night lab are not run.

# Changed files

- `supabase/functions/refresh-views/schedule-results.md`
- `supabase/functions/refresh-views/schedule.test.sql`
- `supabase/migrations/20261214006300_schedule_half_gig.sql`
- `supabase/sql/functions/by-name/private/begin_trade_revaluation.sql`
- `supabase/sql/functions/by-name/private/complete_forecast_input_chunk.sql`
- `supabase/sql/functions/by-name/private/enqueue_matchup_forecasts.sql`
- `supabase/sql/functions/by-name/private/enqueue_player_injuries.sql`
- `supabase/sql/functions/by-name/private/enqueue_rankings.sql`
- `supabase/sql/functions/by-name/private/enqueue_scheduled_work.sql`
- `supabase/sql/functions/by-name/private/enqueue_trade_revaluation_scan.sql`
- `supabase/sql/functions/by-name/private/maintain_player_season_totals.sql`
- `supabase/sql/functions/by-name/private/matchup_forecast_input_fingerprint.sql`
- `supabase/sql/functions/by-name/private/projection_sync_due_work.sql`
- `supabase/sql/functions/by-name/private/queue_changed_matchup_forecasts.sql`
- `supabase/sql/functions/by-name/private/queue_matchup_forecast_expiry.sql`
- `supabase/sql/functions/by-name/private/queue_matchup_forecasts.sql`
- `supabase/sql/functions/by-name/private/rebuild_game_player_totals.sql`
- `supabase/sql/functions/by-name/private/refresh_changed_screen_views.sql`
- `supabase/sql/functions/by-name/private/refresh_matchup_forecast_input.sql`
- `supabase/sql/functions/by-name/private/refresh_queue_screen_views.sql`
- `supabase/sql/functions/by-name/private/refresh_queue_trade_revaluation.sql`
- `supabase/sql/functions/by-name/private/refresh_trade_values.sql`
- `supabase/sql/functions/by-name/private/trade_revaluation_next_change.sql`
- `supabase/sql/functions/by-name/private/work_execute.sql`
- `supabase/sql/functions/by-name/public/claim_matchup_forecasts.sql`
- `supabase/sql/functions/by-name/public/complete_matchup_forecast.sql`
- `supabase/sql/functions/by-name/public/dispatch_work.sql`
- `supabase/sql/functions/by-name/public/view_refresh_work.sql`
