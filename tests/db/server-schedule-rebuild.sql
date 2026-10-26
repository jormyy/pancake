BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; extra record; u uuid; m uuid; result jsonb; original uuid[]; payload jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9524,'setup');
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
    SELECT 9524,n,date '2090-01-02'+(n-1)*7,date '2090-01-08'+(n-1)*7 FROM generate_series(1,24) n;
  INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    SELECT '002rebuild'||n,9524,n,date '2090-01-02'+(n-1)*7,'REB','ILD','Scheduled' FROM generate_series(1,24) n;
  result:=public.replace_regular_season_matchups_atomic(p_league_id=>f.league_id,p_league_season_id=>f.season_id,p_force=>false,p_matchups=>'[]');
  PERFORM pg_temp.check_rules((result->>'inserted')::int=19 AND NOT (result->>'skipped')::boolean,'initial SQL schedule includes two teams');
  SELECT array_agg(id) INTO original FROM matchups WHERE league_season_id=f.season_id;
  result:=public.replace_regular_season_matchups_atomic(f.league_id,f.season_id,false,'[]');
  PERFORM pg_temp.check_rules(result='{"inserted":0,"skipped":true}'::jsonb,'existing schedule skips without changing identities');
  PERFORM pg_temp.check_rules((SELECT array_agg(id ORDER BY id)=(SELECT array_agg(id ORDER BY id) FROM unnest(original) id) FROM matchups WHERE league_season_id=f.season_id),'skipped generation preserves every matchup identity');
  FOR n IN 1..2 LOOP
    u:=gen_random_uuid(); m:=gen_random_uuid();
    INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,u::text||'@example.test','{}');
    INSERT INTO league_members(id,league_id,user_id,team_name) VALUES(m,f.league_id,u,'Late team '||n);
  END LOOP;
  result:=public.replace_regular_season_matchups_atomic(p_league_id=>f.league_id,p_league_season_id=>f.season_id,p_force=>true,p_matchups=>'[]');
  PERFORM pg_temp.check_rules((result->>'inserted')::int=38 AND NOT (result->>'skipped')::boolean,'forced SQL rebuild includes late-joining members');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM matchups WHERE id=ANY(original)),'reset replaces old matchup rows');
  PERFORM pg_temp.check_rules((SELECT count(DISTINCT member_id)=4 FROM matchups CROSS JOIN LATERAL
    (VALUES(home_member_id),(away_member_id)) m(member_id) WHERE league_season_id=f.season_id),'rebuilt schedule covers all members');
  payload:=private.regular_season_matchup_payload(f.league_id,f.season_id,19);
  result:=public.replace_regular_season_matchups_atomic(f.league_id,f.season_id,true,payload);
  PERFORM pg_temp.check_rules((result->>'inserted')::int=38,'deployed Edge payload remains compatible');
  UPDATE matchups SET home_points=1 WHERE league_season_id=f.season_id AND week_number=1;
  PERFORM pg_temp.reject_rules(format('SELECT public.replace_regular_season_matchups_atomic(%L,%L,true,%L)',f.league_id,f.season_id,'[]'),
    'The season has started; the schedule can no longer be rebuilt.','force refuses a started schedule');
  result:=public.replace_regular_season_matchups_atomic(f.league_id,f.season_id,false,'[]');
  PERFORM pg_temp.check_rules((result->>'skipped')::boolean,'existing schedule is reported as skipped');
  UPDATE matchups SET home_points=0,is_finalized=true WHERE league_season_id=f.season_id;
  SELECT array_agg(id ORDER BY id) INTO original FROM matchups WHERE league_season_id=f.season_id;
  PERFORM pg_temp.reject_rules(format('SELECT public.replace_regular_season_matchups_atomic(%L,%L,true,%L)',f.league_id,f.season_id,'[]'),
    'The season has started; the schedule can no longer be rebuilt.','force refuses finalized schedules');
  PERFORM pg_temp.check_rules((SELECT array_agg(id ORDER BY id)=original FROM matchups WHERE league_season_id=f.season_id),'refused reset preserves finalized matchup identities');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
