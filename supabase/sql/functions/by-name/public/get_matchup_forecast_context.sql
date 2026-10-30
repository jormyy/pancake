-- Canonical SQL source for public.get_matchup_forecast_context.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE selected_league uuid; selected_year integer; selected_players uuid[]; context jsonb;
BEGIN
  IF private.matchup_forecast_inputs_ready(p_matchup_id) THEN
    context:=private.read_matchup_forecast_context(p_matchup_id);
  ELSE
    context:=private.compute_matchup_forecast_context(p_matchup_id);
  END IF;
  SELECT m.league_id,s.season_year,ARRAY(
    SELECT r.player_id FROM public.roster_players r WHERE r.league_season_id=m.league_season_id
      AND r.member_id IN(m.home_member_id,m.away_member_id)
  ) INTO selected_league,selected_year,selected_players
  FROM public.matchups m JOIN public.league_seasons s ON s.id=m.league_season_id WHERE m.id=p_matchup_id;
  RETURN context || jsonb_build_object('seasonAverages',COALESCE((
    SELECT jsonb_agg(jsonb_build_object('player_id',a.player_id,'avg_fantasy_points',a.avg_fantasy_points) ORDER BY a.player_id)
    FROM public.v_player_avg_fantasy_points a
    WHERE a.league_id=selected_league AND a.season_year=selected_year AND a.player_id=ANY(selected_players)
  ),'[]'::jsonb));
END;
$$;
