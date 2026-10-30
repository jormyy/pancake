-- Canonical SQL source for private.refresh_player_averages.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.refresh_player_averages(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE selected_year integer; settings jsonb; full_refresh boolean; affected uuid[];
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT season.season_year,league.scoring_settings,
    NOT queued.averages_initialized OR queued.averages_scoring IS DISTINCT FROM league.scoring_settings
    INTO STRICT selected_year,settings,full_refresh
    FROM public.league_seasons season JOIN public.leagues league ON league.id=season.league_id
    JOIN private.screen_refresh_queue queued ON queued.league_season_id=season.id WHERE season.id=p_season_id;
  SELECT array_agg(player_id) INTO affected FROM (
    SELECT player_id FROM private.screen_average_dirty WHERE league_season_id=p_season_id FOR UPDATE
  ) changed;
  IF NOT full_refresh AND affected IS NULL THEN RETURN true; END IF;
  WITH source AS MATERIALIZED (
    SELECT COALESCE(average.player_id,fantasy.player_id) AS player_id,average.averages,fantasy.avg_fantasy_points
    FROM (SELECT average.player_id,to_jsonb(average) AS averages FROM public.mv_player_season_averages average WHERE average.season_year=selected_year AND (full_refresh OR average.player_id=ANY(affected))) average
    FULL JOIN (SELECT player_id,avg_fantasy_points FROM public.v_player_avg_fantasy_points WHERE league_id=p_league_id AND season_year=selected_year AND (full_refresh OR player_id=ANY(affected))) fantasy USING(player_id)
  ), changed AS (
    INSERT INTO public.player_season_averages AS cached(league_id,league_season_id,season_year,player_id,averages,avg_fantasy_points,version)
    SELECT p_league_id,p_season_id,selected_year,source.player_id,source.averages,source.avg_fantasy_points,p_version FROM source
    ON CONFLICT(league_id,season_year,player_id) DO UPDATE SET averages=EXCLUDED.averages,avg_fantasy_points=EXCLUDED.avg_fantasy_points,
      version=EXCLUDED.version,refreshed_at=now() WHERE cached.version<=EXCLUDED.version
      AND (md5((to_jsonb(cached)-ARRAY['version','refreshed_at'])::text)
        IS DISTINCT FROM md5((to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at'])::text)
        OR (to_jsonb(cached)-ARRAY['version','refreshed_at']) IS DISTINCT FROM (to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at']))
    RETURNING player_id
  )
  DELETE FROM public.player_season_averages cached WHERE cached.league_season_id=p_season_id
    AND (full_refresh OR cached.player_id=ANY(affected))
    AND (cached.season_year<>selected_year OR NOT EXISTS(SELECT 1 FROM source WHERE source.player_id=cached.player_id));
  DELETE FROM private.screen_average_dirty WHERE league_season_id=p_season_id AND player_id=ANY(affected);
  UPDATE private.screen_refresh_queue SET averages_initialized=true,averages_scoring=settings WHERE league_season_id=p_season_id;
  RETURN true;
END;
$$;
