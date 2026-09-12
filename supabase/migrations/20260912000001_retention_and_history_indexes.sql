-- Indexes for the weekly retention prune (prune_unbounded_history, 20260815000004).
--
-- The prune deletes sync_runs and projection_sync_runs by a bare started_at
-- predicate; the existing composite indexes lead with function_name/source/
-- status, so the prune scanned both tables in full on every run and they are
-- the fastest-growing tables (one row per cron tick). The standings prune runs
-- a correlated max(week_number) per (league_season_id, member_id) that only
-- had a member_id index.
--
-- The per-player transaction history read is already served by
-- idx_roster_transactions_player_league_occurred (20260702000003); no index is
-- added for it here.
--
-- Plain btree indexes on small or pruned tables, built inside the migration
-- transaction with a 5 s lock timeout; a failed build rolls back and stops the
-- deploy. No predeploy CONCURRENTLY build exists for these (only 20260710130000
-- has one). Add one before shipping if production row counts turn out large.

SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at
  ON public.sync_runs (started_at);

CREATE INDEX IF NOT EXISTS idx_projection_sync_runs_started_at
  ON public.projection_sync_runs (started_at);

CREATE INDEX IF NOT EXISTS idx_standings_season_member_week
  ON public.standings (league_season_id, member_id, week_number DESC);

RESET statement_timeout;
RESET lock_timeout;
