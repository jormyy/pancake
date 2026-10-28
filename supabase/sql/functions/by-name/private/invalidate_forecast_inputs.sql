CREATE OR REPLACE FUNCTION private.invalidate_forecast_inputs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_history boolean:=false; v_projection boolean:=false;
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    v_history:=TG_TABLE_NAME IN('player_game_stats','nba_games');
    v_projection:=TG_TABLE_NAME<>'player_game_stats';
  ELSIF TG_TABLE_NAME='player_game_stats' THEN
    IF TG_OP<>'DELETE' THEN SELECT EXISTS(SELECT 1 FROM forecast_new WHERE game_date<v_today) INTO v_history; END IF;
    IF TG_OP<>'INSERT' AND NOT v_history THEN SELECT EXISTS(SELECT 1 FROM forecast_old WHERE game_date<v_today) INTO v_history; END IF;
  ELSIF TG_TABLE_NAME='nba_games' AND TG_OP='UPDATE' THEN
    SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
      WHERE (o.game_date<v_today OR n.game_date<v_today)
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
      IF TG_TABLE_NAME='nba_games' THEN SELECT EXISTS(SELECT 1 FROM forecast_new WHERE game_date<v_today) INTO v_history; END IF;
    ELSE
      SELECT EXISTS(SELECT 1 FROM forecast_old) INTO v_projection;
      IF TG_TABLE_NAME='nba_games' THEN SELECT EXISTS(SELECT 1 FROM forecast_old WHERE game_date<v_today) INTO v_history; END IF;
    END IF;
  END IF;
  UPDATE private.forecast_input_revisions SET revision=revision+1
    WHERE kind='history' AND v_history OR kind='projection' AND v_projection;
  RETURN NULL;
END;
$$;
