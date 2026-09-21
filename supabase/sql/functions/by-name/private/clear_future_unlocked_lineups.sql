-- Canonical SQL source for private.clear_future_unlocked_lineups.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.clear_future_unlocked_lineups(
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid,
  p_member_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM weekly_lineups AS wl
   WHERE wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.player_id = p_player_id
     AND (p_member_id IS NULL OR wl.member_id = p_member_id)
     AND wl.game_date >= (now() AT TIME ZONE 'America/New_York')::date
     AND NOT private.lineup_game_started(wl.player_id, wl.game_date);
$$;
