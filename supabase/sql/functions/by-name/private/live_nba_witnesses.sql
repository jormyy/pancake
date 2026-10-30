-- Canonical SQL source for private.live_nba_witnesses.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.live_nba_witnesses(p_stats jsonb)
RETURNS uuid[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(array_agg(row.player_id ORDER BY row.player_id),'{}'::uuid[])
  FROM jsonb_populate_recordset(NULL::public.player_game_stats,p_stats) AS row
  WHERE NOT (row.did_not_play IS TRUE AND ROW(row.minutes_played, row.points, row.rebounds, row.offensive_rebounds,
          row.defensive_rebounds, row.assists, row.steals, row.blocks, row.turnovers,
          row.personal_fouls, row.field_goals_made, row.field_goals_attempted,
          row.three_pointers_made, row.three_pointers_attempted, row.free_throws_made,
          row.free_throws_attempted, row.plus_minus, row.double_double, row.triple_double)
          IS NOT DISTINCT FROM ROW(0::numeric, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, false));
$$;
