-- ============================================================
-- Migration: Add live score columns to nba_games
--
-- Populated by livePoller every ~15s during active games so
-- the frontend can subscribe via Supabase realtime and display
-- live NBA scores without a separate backend endpoint.
-- ============================================================

ALTER TABLE nba_games
  ADD COLUMN IF NOT EXISTS home_score   int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS away_score   int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS game_status_text text;
