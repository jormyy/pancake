BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='local-forecast-history-probe';
\ir rules-support.sql
DO $$
DECLARE
  f record; v_matchup uuid:=gen_random_uuid(); v_player uuid:=gen_random_uuid();
  v_game uuid; v_corrected uuid; v_index integer; v_expected jsonb; v_actual jsonb;
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9881);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(9881,1,v_today,v_today+6);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(v_matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  INSERT INTO public.players(id,first_name,last_name,nba_team) VALUES(v_player,'Forecast',v_player::text,'BOS');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],v_player,'draft');
  UPDATE public.leagues SET scoring_settings='{"points":1,"rebounds":1.2,"assists":1.5,"steals":3,"blocks":3,"turnovers":-1,"three_pointers_made":0.5,"field_goals_made":2,"field_goals_attempted":-1,"free_throws_made":1,"free_throws_attempted":-0.5,"double_double":5,"triple_double":10}' WHERE id=f.league_id;
  FOR v_index IN 1..38 LOOP
    v_game:=gen_random_uuid();
    IF v_index=1 THEN v_corrected:=v_game; END IF;
    INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(v_game,CASE WHEN v_index=34 THEN '004-' ELSE '002-' END||v_game,
        CASE WHEN v_index=35 THEN 9879 ELSE 9880 END,1,
        CASE WHEN v_index=36 THEN v_today+1 ELSE v_today-v_index END,'BOS','NYK',
        CASE WHEN v_index=37 THEN 'InProgress' ELSE 'Final' END);
    INSERT INTO public.player_game_stats(player_id,game_id,points,rebounds,assists,steals,blocks,turnovers,
      three_pointers_made,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,
      double_double,triple_double,did_not_play)
    VALUES(v_player,v_game,v_index,10,11,2,1,3,2,4,10,2,3,
      v_index%2=0,v_index%3=0,v_index=38);
  END LOOP;
  SELECT jsonb_agg(public.compute_fantasy_points(h.id,f.league_id) ORDER BY h.game_date,h.id)
    INTO v_expected FROM (
      SELECT s.id,g.game_date FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
      WHERE s.player_id=v_player AND NOT s.did_not_play AND g.status='Final' AND g.game_date<v_today
        AND g.season_year BETWEEN 9880 AND 9881 AND public.is_regular_season_game_id(g.nba_game_id)
      ORDER BY g.game_date DESC,s.id LIMIT 30
    ) h;
  SELECT entry->'scores' INTO v_actual FROM jsonb_array_elements(public.get_matchup_forecast_context(v_matchup)->'history') entry
    WHERE entry->>'player_id'=v_player::text;
  PERFORM pg_temp.check_rules(jsonb_array_length(v_actual)=30,'history keeps only thirty eligible appearances');
  PERFORM pg_temp.check_rules(v_actual=v_expected,'bounded history preserves every scoring category and bonus');
  UPDATE public.nba_games SET game_date=v_today+2 WHERE id=v_corrected;
  SELECT jsonb_agg(public.compute_fantasy_points(h.id,f.league_id) ORDER BY h.game_date,h.id)
    INTO v_expected FROM (
      SELECT s.id,g.game_date FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
      WHERE s.player_id=v_player AND NOT s.did_not_play AND g.status='Final' AND g.game_date<v_today
        AND g.season_year BETWEEN 9880 AND 9881 AND public.is_regular_season_game_id(g.nba_game_id)
      ORDER BY g.game_date DESC,s.id LIMIT 30
    ) h;
  SELECT entry->'scores' INTO v_actual FROM jsonb_array_elements(public.get_matchup_forecast_context(v_matchup)->'history') entry
    WHERE entry->>'player_id'=v_player::text;
  PERFORM pg_temp.check_rules(v_actual=v_expected,'calendar corrections preserve bounded history order and eligibility');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
