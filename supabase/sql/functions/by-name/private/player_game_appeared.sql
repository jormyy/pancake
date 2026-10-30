-- Canonical SQL source for private.player_game_appeared.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.player_game_appeared(p_stats player_game_stats)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(p_stats.minutes_played > 0, false) OR coalesce(greatest(
    p_stats.points,p_stats.rebounds,p_stats.offensive_rebounds,p_stats.defensive_rebounds,
    p_stats.assists,p_stats.steals,p_stats.blocks,p_stats.turnovers,p_stats.personal_fouls,
    p_stats.field_goals_made,p_stats.field_goals_attempted,p_stats.three_pointers_made,
    p_stats.three_pointers_attempted,p_stats.free_throws_made,p_stats.free_throws_attempted) > 0, false);
$$;
