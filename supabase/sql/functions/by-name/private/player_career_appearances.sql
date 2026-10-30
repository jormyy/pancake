-- Canonical SQL source for private.player_career_appearances.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.player_career_appearances(p_player_id uuid, p_after_season integer)
RETURNS integer LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT count(*)::integer
  FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
  WHERE s.player_id=p_player_id AND g.season_year>p_after_season
    AND g.game_date>=(SELECT first_game_date FROM private.provider_history_policy WHERE source='career')
    AND public.is_regular_season_game_id(g.nba_game_id) AND private.player_game_appeared(s);
$$;
