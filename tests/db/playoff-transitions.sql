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
 league_id uuid; season_id uuid; next_id uuid; user_id uuid; commissioner_id uuid; tenth_id uuid;
 teams int; i int; year int:=7300; invite text; result jsonb; message text;
BEGIN
 WHILE EXISTS(SELECT 1 FROM public.season_weeks WHERE season_year IN(year,year+1)) OR EXISTS(SELECT 1 FROM public.league_seasons WHERE season_year IN(year,year+1)) LOOP year:=year+2; END LOOP;
 INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
 SELECT year,w,make_date(year,1,1)+(w-1)*7,make_date(year,1,7)+(w-1)*7 FROM generate_series(1,30)w;
 INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
 SELECT year+1,w,make_date(year+1,1,1)+(w-1)*7,make_date(year+1,1,7)+(w-1)*7 FROM generate_series(1,23)w;
 FOREACH teams IN ARRAY ARRAY[9,4] LOOP
  league_id:=gen_random_uuid(); season_id:=gen_random_uuid(); invite:=upper(substr(replace(league_id::text,'-',''),1,16));
  FOR i IN 1..CASE WHEN teams=9 THEN 10 ELSE 4 END LOOP
   user_id:=gen_random_uuid();
   INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
   VALUES(user_id,'authenticated','authenticated',user_id||'@example.test','x',now(),'{}','{}',now(),now());
   INSERT INTO public.profiles(id,username,display_name) VALUES(user_id,'transition_'||user_id,'Synthetic playoff transition') ON CONFLICT(id)DO NOTHING;
   IF i=1 THEN
    commissioner_id:=user_id;
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,playoff_start_week,invite_code) VALUES(league_id,'Synthetic transition',league_id::text,user_id,'setup',20,invite);
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(season_id,league_id,year,true);
   END IF;
   IF i<=teams THEN INSERT INTO public.league_members(league_id,user_id,role,team_name) VALUES(league_id,user_id,CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::public.league_member_role,'Transition '||i);
   ELSE tenth_id:=user_id; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',commissioner_id::text,true);
  PERFORM public.update_league_settings_atomic(league_id,jsonb_build_object('playoff_start_week',CASE WHEN teams=9 THEN 8 ELSE 25 END,'playoff_total_weeks',5,'playoff_round_weeks',ARRAY[2,3]));
  IF teams=9 THEN
   PERFORM set_config('request.jwt.claim.sub',tenth_id::text,true);
   PERFORM public.join_league_by_invite_code(invite,'Tenth actual join');
   PERFORM set_config('request.jwt.claim.sub',commissioner_id::text,true);
   PERFORM pg_temp.playoff_fails(format('SELECT public.start_auction_draft_atomic(%L)',league_id),'need 3 rounds','C048 start rejects outdated round plan');
   PERFORM pg_temp.playoff_fails(format('SELECT public.replace_regular_season_matchups_atomic(%L,%L,false,%L)',league_id,season_id,private.regular_season_matchup_payload(league_id,season_id,7)),'need 3 rounds','C048 direct generator rejects outdated plan');
   PERFORM pg_temp.playoff_check(NOT EXISTS(SELECT 1 FROM public.drafts d WHERE d.league_id=league_id) AND NOT EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id=season_id),'C048 rejected calls create no draft or matchups');
   PERFORM public.update_league_settings_atomic(league_id,'{"playoff_round_weeks":[1,2,2]}');
   PERFORM public.start_auction_draft_atomic(league_id);
   result:=public.replace_regular_season_matchups_atomic(league_id,season_id,false,private.regular_season_matchup_payload(league_id,season_id,7));
   PERFORM pg_temp.playoff_check((result->>'inserted')::int=35,'C048 explicit repair permits draft and schedule');
   UPDATE public.matchups SET is_finalized=true,winner_member_id=home_member_id,home_points=1,away_points=0 WHERE league_season_id=season_id;
   result:=public.generate_playoff_bracket_atomic(league_id);
   PERFORM pg_temp.playoff_check((result->>'inserted')::int=2,'C048 repaired plan generates quarterfinals');
  ELSE
   UPDATE public.leagues SET status='playoffs' WHERE id=league_id;
   SELECT new_season_id INTO next_id FROM public.advance_season_atomic(league_id);
   PERFORM pg_temp.playoff_fails(format('SELECT public.replace_regular_season_matchups_atomic(%L,%L,false,%L)',league_id,next_id,private.regular_season_matchup_payload(league_id,next_id,24)),'finish by week 23','C049 shorter next calendar rejects invalid schedule');
   PERFORM pg_temp.playoff_check(NOT EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id=next_id),'C049 rejected calendar leaves new season empty');
   PERFORM public.update_league_settings_atomic(league_id,'{"playoff_start_week":19}');
   result:=public.replace_regular_season_matchups_atomic(league_id,next_id,false,private.regular_season_matchup_payload(league_id,next_id,18));
   PERFORM pg_temp.playoff_check((result->>'inserted')::int=36,'C049 explicit valid repair creates supported regular schedule');
  END IF;
 END LOOP;
END $$;
TABLE playoff_check_names;
ROLLBACK;
