CREATE OR REPLACE FUNCTION private.invalidate_forecast_inputs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_history boolean:=false; v_projection boolean:=false; v_source boolean:=false;
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF TG_TABLE_NAME='search_cache_refresh_state' THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' AND TG_TABLE_NAME IN('projection_sync_runs','fantasypros_projection_rows','sleeper_projection_rows')
    AND current_setting('pancake.projection_cleanup',true)='on' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME IN('player_projections','fantasypros_projection_rows','sleeper_projection_rows','projection_sync_runs') THEN
    IF TG_OP='TRUNCATE' THEN v_source:=true;
    ELSIF TG_TABLE_NAME='fantasypros_projection_rows' AND TG_OP='UPDATE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
        WHERE (to_jsonb(o)-ARRAY['updated_at','created_at']) IS DISTINCT FROM (to_jsonb(n)-ARRAY['updated_at','created_at'])
          AND EXISTS(SELECT 1 FROM public.projection_sync_runs r WHERE r.id IN(o.run_id,n.run_id)
            AND r.status='success' AND r.completed_at IS NOT NULL)) INTO v_source;
    ELSIF TG_TABLE_NAME='fantasypros_projection_rows' AND TG_OP='INSERT' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_new n JOIN public.projection_sync_runs r ON r.id=n.run_id
        WHERE r.status='success' AND r.completed_at IS NOT NULL) INTO v_source;
    ELSIF TG_TABLE_NAME='fantasypros_projection_rows' AND TG_OP='DELETE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN public.projection_sync_runs r ON r.id=o.run_id
        WHERE r.status='success' AND r.completed_at IS NOT NULL) INTO v_source;
    ELSIF TG_TABLE_NAME='projection_sync_runs' AND TG_OP='UPDATE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
        WHERE (o.status='success' AND o.completed_at IS NOT NULL OR n.status='success' AND n.completed_at IS NOT NULL)
          AND (o.source,o.projection_type,o.projection_date,o.season_year,o.week_number,o.status,o.started_at,o.completed_at)
            IS DISTINCT FROM (n.source,n.projection_type,n.projection_date,n.season_year,n.week_number,n.status,n.started_at,n.completed_at)) INTO v_source;
    ELSIF TG_TABLE_NAME='projection_sync_runs' AND TG_OP='INSERT' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_new WHERE status='success' AND completed_at IS NOT NULL) INTO v_source;
    ELSIF TG_TABLE_NAME='projection_sync_runs' AND TG_OP='DELETE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_old WHERE status='success' AND completed_at IS NOT NULL) INTO v_source;
    ELSIF TG_OP='UPDATE' THEN
      SELECT EXISTS(SELECT to_jsonb(n)-ARRAY['updated_at','created_at'] FROM forecast_new n
        EXCEPT SELECT to_jsonb(o)-ARRAY['updated_at','created_at'] FROM forecast_old o) INTO v_source;
    ELSIF TG_OP='INSERT' THEN SELECT EXISTS(SELECT 1 FROM forecast_new) INTO v_source;
    ELSE SELECT EXISTS(SELECT 1 FROM forecast_old) INTO v_source;
    END IF;
    IF NOT v_source THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP='TRUNCATE' THEN
    v_history:=TG_TABLE_NAME IN('player_game_stats','nba_games');
    v_projection:=TG_TABLE_NAME<>'player_game_stats';
  ELSIF TG_TABLE_NAME='player_game_stats' THEN
    IF TG_OP='UPDATE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
        WHERE (o.game_date<v_today OR n.game_date<v_today)
          AND EXISTS(SELECT 1 FROM public.nba_games g WHERE g.id IN(o.game_id,n.game_id)
            AND g.status='Final' AND public.is_regular_season_game_id(g.nba_game_id))
          AND (to_jsonb(o)-ARRAY['updated_at','created_at','fetched_at']) IS DISTINCT FROM
            (to_jsonb(n)-ARRAY['updated_at','created_at','fetched_at'])) INTO v_history;
    ELSE
      IF TG_OP='INSERT' THEN SELECT EXISTS(SELECT 1 FROM forecast_new n JOIN public.nba_games g ON g.id=n.game_id
        WHERE n.game_date<v_today AND g.status='Final' AND public.is_regular_season_game_id(g.nba_game_id)) INTO v_history;
      ELSE SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN public.nba_games g ON g.id=o.game_id
        WHERE o.game_date<v_today AND g.status='Final' AND public.is_regular_season_game_id(g.nba_game_id)) INTO v_history;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='nba_games' AND TG_OP='UPDATE' THEN
    SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
      WHERE (o.game_date<v_today OR n.game_date<v_today)
        AND (o.status='Final' OR n.status='Final')
        AND (o.game_date,o.season_year,o.status,o.nba_game_id) IS DISTINCT FROM (n.game_date,n.season_year,n.status,n.nba_game_id))
      INTO v_history;
    SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
      WHERE (o.game_date,o.season_year,o.status,o.nba_game_id,o.home_team,o.away_team,o.game_time,o.started_at)
        IS DISTINCT FROM (n.game_date,n.season_year,n.status,n.nba_game_id,n.home_team,n.away_team,n.game_time,n.started_at))
      INTO v_projection;
  ELSIF TG_TABLE_NAME='players' AND TG_OP='UPDATE' THEN
    SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
      WHERE (o.nba_team,o.first_name,o.last_name,o.display_name)
        IS DISTINCT FROM (n.nba_team,n.first_name,n.last_name,n.display_name)) INTO v_projection;
  ELSIF TG_TABLE_NAME='leagues' AND TG_OP='UPDATE' THEN
    SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
      WHERE o.scoring_settings IS DISTINCT FROM n.scoring_settings) INTO v_projection;
  ELSE
    IF TG_OP<>'DELETE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_new) INTO v_projection;
      IF TG_TABLE_NAME='nba_games' THEN SELECT EXISTS(SELECT 1 FROM forecast_new
        WHERE game_date<v_today AND status='Final' AND public.is_regular_season_game_id(nba_game_id)) INTO v_history; END IF;
    ELSE
      SELECT EXISTS(SELECT 1 FROM forecast_old) INTO v_projection;
      IF TG_TABLE_NAME='nba_games' THEN SELECT EXISTS(SELECT 1 FROM forecast_old
        WHERE game_date<v_today AND status='Final' AND public.is_regular_season_game_id(nba_game_id)) INTO v_history; END IF;
    END IF;
  END IF;
  UPDATE private.forecast_input_revisions SET revision=revision+1
    WHERE kind='history' AND v_history OR kind='projection' AND v_projection OR kind='source' AND v_source;
  IF v_history OR v_projection THEN PERFORM private.queue_matchup_forecasts(); END IF;
  RETURN NULL;
END;
$$;
