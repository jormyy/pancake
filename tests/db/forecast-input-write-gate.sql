\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='forecast-input-fixture';
\ir rules-support.sql
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); player uuid:=gen_random_uuid(); other_player uuid:=gen_random_uuid();
  today date:=(now() AT TIME ZONE 'America/New_York')::date; game_day date:=today+1;
  before_ctid tid; after_ctid tid; previous_revision bigint; previous_roster text; previous_scoring text;
  initial_updates bigint; iteration integer;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9878);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9878,1,today,today+6);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  INSERT INTO public.players(id,first_name,last_name,nba_team) VALUES(player,'Forecast',player::text,'BOS'),(other_player,'Forecast',other_player::text,'LAL');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],player,'draft');
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('002-'||gen_random_uuid(),9878,1,game_day,(game_day+time '22:00') AT TIME ZONE 'UTC','BOS','LAL','Scheduled');
  PERFORM public.prepare_matchup_forecast_inputs(matchup);
  PERFORM public.prepare_matchup_forecast_inputs(matchup,game_day);
  SELECT ctid,revision,roster_hash,scoring_hash INTO before_ctid,previous_revision,previous_roster,previous_scoring
    FROM private.forecast_projection_inputs WHERE matchup_id=matchup AND game_date=game_day;
  PERFORM pg_temp.check_rules(before_ctid IS NOT NULL,'the requested projection date is prepared');
  initial_updates:=pg_stat_get_xact_tuples_updated('private.forecast_projection_inputs'::regclass);
  FOR iteration IN 1..20 LOOP PERFORM public.prepare_matchup_forecast_inputs(matchup,game_day); END LOOP;
  SELECT ctid INTO after_ctid FROM private.forecast_projection_inputs WHERE matchup_id=matchup AND game_date=game_day;
  PERFORM pg_temp.check_rules(after_ctid=before_ctid,'repeated current requests keep the physical cache row');
  PERFORM pg_temp.check_rules(pg_stat_get_xact_tuples_updated('private.forecast_projection_inputs'::regclass)=initial_updates,'repeated current requests write no cache versions');
  INSERT INTO public.player_projections(player_id,season_year,week_number,projected_stat_points,fetched_at)
    VALUES(player,9878,1,99,now());
  PERFORM public.prepare_matchup_forecast_inputs(matchup,game_day);
  PERFORM pg_temp.check_rules((SELECT revision>previous_revision FROM private.forecast_projection_inputs
    WHERE matchup_id=matchup AND game_date=game_day),'changed source projections replace the cached revision');
  UPDATE public.leagues SET scoring_settings=scoring_settings||'{"points":2}'::jsonb WHERE id=f.league_id;
  PERFORM public.prepare_matchup_forecast_inputs(matchup,game_day);
  PERFORM pg_temp.check_rules((SELECT scoring_hash<>previous_scoring FROM private.forecast_projection_inputs
    WHERE matchup_id=matchup AND game_date=game_day),'changed scoring rules replace the cached inputs');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[2],other_player,'draft');
  PERFORM public.prepare_matchup_forecast_inputs(matchup,game_day);
  PERFORM pg_temp.check_rules((SELECT roster_hash<>previous_roster FROM private.forecast_projection_inputs
    WHERE matchup_id=matchup AND game_date=game_day),'changed rosters replace the cached inputs');
  UPDATE private.forecast_projection_inputs SET valid_until=now() WHERE matchup_id=matchup AND game_date=game_day;
  PERFORM public.prepare_matchup_forecast_inputs(matchup,game_day);
  PERFORM pg_temp.check_rules((SELECT valid_until>now() FROM private.forecast_projection_inputs
    WHERE matchup_id=matchup AND game_date=game_day),'expired inputs refresh before reuse');
  UPDATE private.forecast_projection_inputs SET observed_date=today-1 WHERE matchup_id=matchup AND game_date=game_day;
  PERFORM public.prepare_matchup_forecast_inputs(matchup,game_day);
  PERFORM pg_temp.check_rules((SELECT observed_date=today FROM private.forecast_projection_inputs
    WHERE matchup_id=matchup AND game_date=game_day),'a previous observation day refreshes before reuse');
  PERFORM public.prepare_matchup_forecast_inputs(matchup,today+15);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT FROM private.forecast_projection_inputs
    WHERE matchup_id=matchup AND game_date=today+15),'dates outside the matchup remain excluded');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
