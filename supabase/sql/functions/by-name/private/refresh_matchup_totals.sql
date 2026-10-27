CREATE OR REPLACE FUNCTION private.refresh_matchup_totals(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.matchup_totals AS cached(matchup_id, league_id, league_season_id, home_points, away_points, home_max_possible_points, away_max_possible_points, version)
  SELECT id, league_id, league_season_id, home_points, away_points, home_max_possible_points, away_max_possible_points, p_version
  FROM public.matchups WHERE league_id = p_league_id AND league_season_id = p_season_id AND NOT is_voided
  ON CONFLICT (matchup_id) DO UPDATE SET home_points = EXCLUDED.home_points, away_points = EXCLUDED.away_points,
    home_max_possible_points = EXCLUDED.home_max_possible_points, away_max_possible_points = EXCLUDED.away_max_possible_points,
    version = EXCLUDED.version, refreshed_at = now() WHERE cached.version < EXCLUDED.version;
  DELETE FROM public.matchup_totals cached WHERE cached.league_season_id = p_season_id AND cached.version < p_version
    AND NOT EXISTS (SELECT 1 FROM public.matchups matchup WHERE matchup.id = cached.matchup_id AND NOT matchup.is_voided);
  RETURN true;
END;
$$;
