CREATE OR REPLACE FUNCTION public.get_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN private.matchup_forecast_inputs_ready(p_matchup_id)
    THEN private.read_matchup_forecast_context(p_matchup_id)
    ELSE private.compute_matchup_forecast_context(p_matchup_id) END || jsonb_build_object('seasonAverages',COALESCE((
    SELECT jsonb_agg(jsonb_build_object('player_id',a.player_id,'avg_fantasy_points',a.avg_fantasy_points) ORDER BY a.player_id)
    FROM public.matchups m
    JOIN public.league_seasons s ON s.id=m.league_season_id
    JOIN public.v_player_avg_fantasy_points a ON a.league_id=m.league_id AND a.season_year=s.season_year
    WHERE m.id=p_matchup_id AND EXISTS (
      SELECT 1 FROM public.roster_players r WHERE r.league_season_id=m.league_season_id
        AND r.member_id IN(m.home_member_id,m.away_member_id) AND r.player_id=a.player_id
    )
  ),'[]'::jsonb));
$$;
