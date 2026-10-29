SET lock_timeout='500ms';
SET statement_timeout='30s';

CREATE OR REPLACE FUNCTION private.refresh_player_averages(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE selected_year integer;
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT season.season_year INTO STRICT selected_year FROM public.league_seasons season WHERE season.id = p_season_id;
  WITH source AS MATERIALIZED (
    SELECT COALESCE(average.player_id,fantasy.player_id) AS player_id,average.averages,fantasy.avg_fantasy_points
    FROM (SELECT average.player_id,to_jsonb(average) AS averages FROM public.mv_player_season_averages average WHERE average.season_year=selected_year) average
    FULL JOIN (SELECT player_id,avg_fantasy_points FROM public.v_player_avg_fantasy_points WHERE league_id=p_league_id AND season_year=selected_year) fantasy USING(player_id)
  ), changed AS (
    INSERT INTO public.player_season_averages AS cached(league_id,league_season_id,season_year,player_id,averages,avg_fantasy_points,version)
    SELECT p_league_id,p_season_id,selected_year,source.player_id,source.averages,source.avg_fantasy_points,p_version FROM source
    ON CONFLICT(league_id,season_year,player_id) DO UPDATE SET averages=EXCLUDED.averages,avg_fantasy_points=EXCLUDED.avg_fantasy_points,
      version=EXCLUDED.version,refreshed_at=now() WHERE cached.version<EXCLUDED.version
      AND (md5((to_jsonb(cached)-ARRAY['version','refreshed_at'])::text)
        IS DISTINCT FROM md5((to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at'])::text)
        OR (to_jsonb(cached)-ARRAY['version','refreshed_at']) IS DISTINCT FROM (to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at']))
    RETURNING player_id
  )
  DELETE FROM public.player_season_averages cached WHERE cached.league_season_id=p_season_id
    AND NOT EXISTS(SELECT 1 FROM source WHERE source.player_id=cached.player_id);
  RETURN true;
END;
$$;
