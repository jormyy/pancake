-- During live windows the live-poll cron calls syncStatsForDates every minute
-- over yesterday+today, and every Final game got an unconditional CDN box-score
-- fetch plus a full player_game_stats read/diff per tick. Record when a Final
-- game's stats were last synced so the stats sync path can skip recently
-- rechecked Final games (see FINAL_STATS_RECHECK_MS in syncStats.ts).
-- The column rides the table's existing RLS policies; no grant changes needed.
ALTER TABLE nba_games ADD COLUMN IF NOT EXISTS stats_synced_at timestamptz;
