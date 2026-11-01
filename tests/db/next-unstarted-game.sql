BEGIN;
DO $$
DECLARE u uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); p uuid:=gen_random_uuid();
  history uuid:=gen_random_uuid(); g uuid:=gen_random_uuid(); later uuid:=gen_random_uuid(); d date:=(now() AT TIME ZONE 'America/New_York')::date;
  v_case record; v_result record;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,u::text||'@example.test','{}');
  INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(l,'Next game',l::text,u,'active');
  INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions) VALUES(p,'Next','Game','NXT','PG',ARRAY['PG']);
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time) VALUES
    (g,'002next-first',2097,1,d,'NXT','ONE','Scheduled',now()+interval '1 hour'),
    (later,'002next-later',2097,1,d+1,'TWO','NXT','Scheduled',now()+interval '25 hours');
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES(history,'002next-history',2097,1,d-1,'NXT','OLD','Final',now()-interval '1 day');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,points) VALUES(p,history,2097,1,20);
  PERFORM public.refresh_player_search_caches();
  FOR v_case IN SELECT * FROM (VALUES
    ('Scheduled',interval '1 hour',NULL::interval,d),
    ('InProgress',interval '1 hour',NULL::interval,d+1),
    ('Final',interval '1 hour',NULL::interval,d+1),
    ('Scheduled',interval '-1 second',NULL::interval,d+1),
    ('Scheduled',NULL::interval,interval '-1 second',d+1),
    ('Scheduled',NULL::interval,NULL::interval,d)
  ) AS cases(status,tip,start_time,expected_date) LOOP
    UPDATE nba_games SET status=v_case.status,game_time=now()+v_case.tip,started_at=now()+v_case.start_time WHERE id=g;
    SELECT * INTO v_result FROM get_league_projection_rows(l,2097,d,'today',ARRAY[p],1,0);
    IF v_result.next_game_date IS DISTINCT FROM v_case.expected_date THEN RAISE EXCEPTION 'Wrong next game for %: %',v_case,v_result.next_game_date; END IF;
  END LOOP;
  UPDATE nba_games SET status='Final',game_time=now()-interval '1 hour' WHERE id IN(g,later);
  SELECT * INTO v_result FROM get_league_projection_rows(l,2097,d,'today',ARRAY[p],1,0);
  IF v_result.next_game_date IS NOT NULL THEN RAISE EXCEPTION 'Completed schedule returns a next game'; END IF;
END;
$$;
ROLLBACK;
