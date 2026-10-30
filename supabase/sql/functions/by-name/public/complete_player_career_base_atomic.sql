-- Canonical SQL source for public.complete_player_career_base_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.complete_player_career_base_atomic(
  p_player_id uuid, p_espn_id text, p_nba_id text,
  p_base integer DEFAULT NULL, p_base_season integer DEFAULT NULL,
  p_season_year integer DEFAULT public.current_season_year_et()
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_player public.players%ROWTYPE; v_source text; v_first_season integer;
BEGIN
  SELECT first_season_year INTO v_first_season FROM private.provider_history_policy WHERE source='career';
  IF NOT FOUND THEN RAISE EXCEPTION 'Player career coverage policy is unavailable.' USING ERRCODE='55000'; END IF;
  IF p_season_year IS NULL OR p_season_year<v_first_season OR
    (p_base IS NULL) IS DISTINCT FROM (p_base_season IS NULL) OR p_base<0 OR
    (p_base_season IS NOT NULL AND p_base_season<>p_season_year-1) THEN
    RAISE EXCEPTION 'A completed-season NBA career base is required.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_player FROM public.players WHERE id=p_player_id FOR UPDATE;
  IF NOT FOUND OR (v_player.career_games_base IS NOT NULL AND v_player.career_games_base_source<>'coverage')
    OR v_player.espn_id IS DISTINCT FROM nullif(p_espn_id,'')
    OR v_player.nba_id IS DISTINCT FROM nullif(p_nba_id,'') THEN RETURN false; END IF;
  IF p_base IS NULL AND v_player.career_games_base_source='coverage' THEN RETURN false; END IF;
  IF p_base IS NULL THEN
    SELECT base,base_season,source INTO p_base,p_base_season,v_source
      FROM private.player_career_fallback(p_player_id,v_player.years_exp,p_season_year);
    IF p_base IS NULL THEN RETURN false; END IF;
  ELSE
    v_source:='espn';
  END IF;
  IF p_base+private.player_career_appearances(p_player_id,p_base_season)<v_player.career_regular_season_games THEN RETURN false; END IF;
  UPDATE public.players SET career_games_base=p_base,career_games_base_season=p_base_season,
    career_games_base_source=v_source,career_games_base_checked_at=clock_timestamp()
  WHERE id=p_player_id;
  RETURN true;
END;
$$;
