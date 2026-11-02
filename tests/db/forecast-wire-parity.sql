BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='forecast-wire';
\ir rules-support.sql
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); game uuid:=gen_random_uuid(); players uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  day date:=(now() AT TIME ZONE 'America/New_York')::date; raw jsonb; packed jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9532);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9532,1,day,day+6);
  INSERT INTO public.players(id,first_name,last_name,nba_team,eligible_positions)
    VALUES(players[1],'Wire','Starter','BOS',ARRAY['PG']),
      (players[2],'Wire','Bench','BOS',ARRAY['PG']),
      (players[3],'Wire','Other','NYK',ARRAY['C']);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[1],'draft'),
      (f.league_id,f.season_id,f.member_ids[1],players[2],'draft'),
      (f.league_id,f.season_id,f.member_ids[2],players[3],'draft');
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,slot_type)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[1],day,'PG'),
      (f.league_id,f.season_id,f.member_ids[1],players[2],day,'BE'),
      (f.league_id,f.season_id,f.member_ids[2],players[3],day,'C');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES(game,'002-forecast-wire',9532,1,day,now()+interval '1 hour','BOS','NYK','Scheduled');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  PERFORM public.prepare_matchup_forecast_inputs(matchup);
  UPDATE private.forecast_player_history SET scores=ARRAY[10.1,12.4,16.7] WHERE league_id=f.league_id;
  raw:=public.get_prepared_matchup_forecast_context(matchup);
  packed:=public.get_compact_matchup_forecast_context(matchup);
  PERFORM pg_temp.check_rules(jsonb_array_length(packed->'roster')=3,'packed context preserves every automatic lineup candidate');
  PERFORM pg_temp.check_rules(packed->'history'->0->1=raw->'history'->0->'scores','packed history preserves exact score samples');
  PERFORM pg_temp.check_rules(octet_length(packed::text)<octet_length(raw::text),'packed context sends fewer bytes');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.get_compact_matchup_forecast_context(uuid)','EXECUTE'),'compact context stays worker-only');
  RAISE NOTICE 'FORECAST_WIRE_PROOF %',jsonb_build_object('raw',raw,'packed',packed);
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
