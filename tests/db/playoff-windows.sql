-- Actual commissioner settings, atomic schedule replacement and bracket paths.
-- Synthetic data and explicit result fixtures roll back. Scoring has separate tests.
BEGIN;
SET LOCAL statement_timeout = '45s';
SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE playoff_check_names(name text PRIMARY KEY);
CREATE FUNCTION pg_temp.playoff_check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  INSERT INTO playoff_check_names VALUES(label);
END $$;
CREATE FUNCTION pg_temp.playoff_fails(command text, expected text, label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE message text;
BEGIN
  BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
  PERFORM pg_temp.playoff_check(message ~ expected,label||COALESCE(' ['||message||']',' [unexpected success]'));
END $$;
DO $$
#variable_conflict use_variable
DECLARE
  league_id uuid; season_id uuid; user_id uuid; member_id uuid; commissioner_id uuid;
  outsider_id uuid; members uuid[]; worlds int[]:=ARRAY[4,10]; teams int; team_index int;
  season_year int:=7200; before_rows jsonb; after_rows jsonb; result jsonb; round_lengths int[];
  start_week int; total_weeks int; count_rows int; last_week int; old_settings jsonb;
BEGIN
  WHILE EXISTS(SELECT 1 FROM public.season_weeks w WHERE w.season_year=season_year)
     OR EXISTS(SELECT 1 FROM public.league_seasons s WHERE s.season_year=season_year) LOOP
    season_year:=season_year+1;
  END LOOP;
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
  SELECT season_year,w,make_date(season_year,1,1)+(w-1)*7,make_date(season_year,1,7)+(w-1)*7
  FROM generate_series(1,30) w;
  FOREACH teams IN ARRAY worlds LOOP
    league_id:=gen_random_uuid();season_id:=gen_random_uuid();members:='{}';
    FOR team_index IN 1..teams LOOP
      user_id:=gen_random_uuid();member_id:=gen_random_uuid();
      INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES(user_id,'authenticated','authenticated',user_id||'@example.test','x',now(),'{}','{}',now(),now());
      INSERT INTO public.profiles(id,username,display_name) VALUES(user_id,'playoff_'||user_id,'Synthetic playoff manager') ON CONFLICT(id) DO NOTHING;
      IF team_index=1 THEN
        commissioner_id:=user_id;
        INSERT INTO public.leagues(id,name,slug,commissioner_id,status,playoff_start_week)
        VALUES(league_id,'Synthetic playoff window',league_id::text,commissioner_id,'active',20);
        INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(season_id,league_id,season_year,true);
      ELSE outsider_id:=user_id;
      END IF;
      INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
      VALUES(member_id,league_id,user_id,CASE WHEN team_index=1 THEN 'commissioner' ELSE 'manager' END::public.league_member_role,'Playoff team '||team_index);
      members:=array_append(members,member_id);
    END LOOP;
    PERFORM set_config('request.jwt.claim.sub',commissioner_id::text,true);
    round_lengths:=CASE WHEN teams=10 THEN ARRAY[1,2,2] ELSE ARRAY[2,3] END;
    PERFORM public.update_league_settings_atomic(league_id,jsonb_build_object('playoff_start_week',8,'playoff_total_weeks',5,'playoff_round_weeks',round_lengths));
    PERFORM pg_temp.playoff_check(EXISTS(SELECT 1 FROM public.leagues l WHERE l.id=league_id AND l.playoff_start_week=8 AND l.playoff_total_weeks=5 AND l.playoff_round_weeks=round_lengths),teams||' teams explicit early start and total persist');
    result:=public.replace_regular_season_matchups_atomic(league_id,season_id,false,private.regular_season_matchup_payload(league_id,season_id,7));
    PERFORM pg_temp.playoff_check((result->>'inserted')::int=7*(teams/2),teams||' teams regular schedule respects start8');
    SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) INTO before_rows FROM public.matchups m WHERE m.league_season_id=season_id;
    PERFORM public.update_league_settings_atomic(league_id,'{"weekly_add_limit":6}');
    SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) INTO after_rows FROM public.matchups m WHERE m.league_season_id=season_id;
    PERFORM pg_temp.playoff_check(before_rows=after_rows,teams||' teams unrelated save preserves exact schedule');
    PERFORM set_config('request.jwt.claim.sub',outsider_id::text,true);
    PERFORM pg_temp.playoff_fails(format('SELECT public.update_league_settings_atomic(%L,%L)',league_id,'{"playoff_start_week":16}'),'Only the league commissioner',teams||' teams member cannot change playoffs');
    PERFORM set_config('request.jwt.claim.sub',commissioner_id::text,true);
    FOR start_week IN SELECT unnest(ARRAY[16,25,3]) LOOP
      PERFORM public.update_league_settings_atomic(league_id,jsonb_build_object('playoff_start_week',start_week));
      SELECT count(*),max(week_number) INTO count_rows,last_week FROM public.matchups m WHERE m.league_season_id=season_id;
      PERFORM pg_temp.playoff_check(count_rows=(start_week-1)*(teams/2) AND last_week=start_week-1,teams||' teams atomic schedule resize start'||start_week);
    END LOOP;
    PERFORM pg_temp.playoff_fails(format('SELECT public.replace_regular_season_matchups_atomic(%L,%L,true,%L)',league_id,season_id,private.regular_season_matchup_payload(league_id,season_id,1)),'does not match',teams||' teams stale generator cannot shorten saved schedule');
    PERFORM pg_temp.playoff_fails(format('SELECT public.update_league_settings_atomic(%L,%L)',league_id,'{"playoff_start_week":0}'),'positive',teams||' teams zero start rejected');
    PERFORM pg_temp.playoff_fails(format('SELECT public.update_league_settings_atomic(%L,%L)',league_id,'{"playoff_start_week":1.5}'),'whole',teams||' teams fractional start rejected');
    PERFORM pg_temp.playoff_fails(format('SELECT public.update_league_settings_atomic(%L,%L)',league_id,'{"playoff_start_week":30}'),'finish by week',teams||' teams calendar overflow rejected');
    PERFORM pg_temp.playoff_fails(format('SELECT public.update_league_settings_atomic(%L,%L)',league_id,'{"playoff_total_weeks":1,"playoff_round_weeks":[1]}'),'constraint|rounds',teams||' teams too few rounds rejected');
    PERFORM pg_temp.playoff_fails(format('SELECT public.update_league_settings_atomic(%L,%L)',league_id,'{"playoff_total_weeks":4}'),'constraint|rounds',teams||' teams unequal total rejected');
    DELETE FROM public.season_weeks w WHERE w.season_year=season_year AND week_number=4;
    PERFORM pg_temp.playoff_fails(format('SELECT public.update_league_settings_atomic(%L,%L)',league_id,'{"playoff_start_week":2}'),'missing week',teams||' teams calendar gap rejected');
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(season_year,4,make_date(season_year,1,1)+21,make_date(season_year,1,7)+21);
    PERFORM public.update_league_settings_atomic(league_id,jsonb_build_object('playoff_start_week',1));
    PERFORM pg_temp.playoff_check(NOT EXISTS(SELECT 1 FROM public.matchups m WHERE m.league_season_id=season_id),teams||' teams start1 has zero regular weeks');
    result:=public.generate_playoff_bracket_atomic(league_id);
    PERFORM pg_temp.playoff_check((result->>'inserted')::int=2,teams||' teams bracket starts without regular season');
    PERFORM pg_temp.playoff_check(NOT EXISTS(SELECT 1 FROM public.matchups m WHERE m.league_season_id=season_id AND (m.week_number<>1 OR m.end_week_number<>round_lengths[1])),teams||' teams first round saved span');
    -- An existing future bracket is rebuilt only by an explicit setting change.
    PERFORM public.update_league_settings_atomic(league_id,'{"playoff_start_week":2}');
    PERFORM pg_temp.playoff_check(NOT EXISTS(SELECT 1 FROM public.matchups m WHERE m.league_season_id=season_id AND m.matchup_type<>'regular_season'),teams||' teams future bracket replaced coherently');
    PERFORM public.update_league_settings_atomic(league_id,'{"playoff_start_week":1}');
    PERFORM public.generate_playoff_bracket_atomic(league_id);
    -- Results below are explicit progression fixtures, not scoring evidence.
    UPDATE public.matchups m SET home_points=10,away_points=9,is_finalized=true,winner_member_id=home_member_id,finalized_at=now()-interval '3 days' WHERE m.league_season_id=season_id;
    result:=public.advance_playoff_bracket_atomic(league_id);
    IF teams=10 THEN
      PERFORM pg_temp.playoff_check((result->>'inserted')::int=2 AND (SELECT bool_and(week_number=2 AND end_week_number=3) FROM public.matchups m WHERE m.league_season_id=season_id AND m.matchup_type='playoff_semifinal'),'six-team semifinal follows quarterfinal and spans2weeks');
      UPDATE public.matchups m SET home_points=10,away_points=9,is_finalized=true,winner_member_id=home_member_id,finalized_at=now()-interval '3 days' WHERE m.league_season_id=season_id AND m.matchup_type='playoff_semifinal';
      result:=public.advance_playoff_bracket_atomic(league_id);
    END IF;
    PERFORM pg_temp.playoff_check((result->>'inserted')::int=1 AND (SELECT bool_and(week_number=CASE WHEN teams=10 THEN 4 ELSE 3 END AND end_week_number=5) FROM public.matchups m WHERE m.league_season_id=season_id AND m.matchup_type='playoff_final'),teams||' teams final ends at configured total5');
    SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) INTO before_rows FROM public.matchups m WHERE m.league_season_id=season_id;
    PERFORM pg_temp.playoff_fails(format('SELECT public.update_league_settings_atomic(%L,%L)',league_id,'{"playoff_start_week":4}'),'schedule has started',teams||' teams decided competition rejects schedule edit');
    SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) INTO after_rows FROM public.matchups m WHERE m.league_season_id=season_id;
    PERFORM pg_temp.playoff_check(before_rows=after_rows,teams||' teams rejected edit preserves all results');
  END LOOP;
END $$;
SELECT count(*) AS passed_checks FROM playoff_check_names;
ROLLBACK;
