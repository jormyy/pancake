CREATE OR REPLACE FUNCTION private.refresh_player_averages(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE selected_year integer;
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT season.season_year INTO STRICT selected_year FROM public.league_seasons season WHERE season.id = p_season_id;
  INSERT INTO public.player_season_averages AS cached(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
  SELECT p_league_id, p_season_id, selected_year, COALESCE(average.player_id, fantasy.player_id), to_jsonb(average), fantasy.avg_fantasy_points, p_version
  FROM (SELECT * FROM public.mv_player_season_averages average WHERE average.season_year = selected_year) average
  FULL JOIN (SELECT * FROM public.v_player_avg_fantasy_points fantasy WHERE fantasy.league_id = p_league_id AND fantasy.season_year = selected_year) fantasy
    ON fantasy.player_id = average.player_id
  ON CONFLICT (league_id, season_year, player_id) DO UPDATE SET averages = EXCLUDED.averages, avg_fantasy_points = EXCLUDED.avg_fantasy_points,
    version = EXCLUDED.version, refreshed_at = now() WHERE cached.version < EXCLUDED.version;
  DELETE FROM public.player_season_averages cached WHERE cached.league_season_id = p_season_id AND cached.version < p_version;
  RETURN true;
END;
$$;
