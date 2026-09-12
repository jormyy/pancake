-- Indexes for the nightly retention prune and the per-player transaction history.
--
-- prune_unbounded_history() (20260815000004) deletes sync_runs and
-- projection_sync_runs by a bare started_at predicate; the existing composite
-- indexes lead with function_name/source/status, so the prune scanned both
-- tables in full every night and they are the fastest-growing tables (one row
-- per cron tick). The standings prune runs a correlated max(week_number) per
-- (league_season_id, member_id) that only had a member_id index. The player
-- transaction history read (lib/players.ts) filters league_id + player_id and
-- sorts by occurred_at desc with only single-column indexes available.
--
-- All four are plain btree indexes on append-mostly tables. Production should
-- build them CONCURRENTLY through the predeploy path (as 20260710130000 does);
-- this statement is the fresh-database fallback and is a no-op once they exist.

SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at
  ON public.sync_runs (started_at);

CREATE INDEX IF NOT EXISTS idx_projection_sync_runs_started_at
  ON public.projection_sync_runs (started_at);

CREATE INDEX IF NOT EXISTS idx_standings_season_member_week
  ON public.standings (league_season_id, member_id, week_number DESC);

CREATE INDEX IF NOT EXISTS idx_roster_transactions_league_player_recent
  ON public.roster_transactions (league_id, player_id, occurred_at DESC);

RESET statement_timeout;
RESET lock_timeout;
