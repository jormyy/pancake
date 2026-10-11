-- Local PostgreSQL integration controls; all changes roll back.
-- A local PostgreSQL owner connection is required for role checks and historical fixture setup.
-- Every change, including trigger disable/re-enable, remains inside this unconditional rollback.
-- C102 controls only. No C103 calendar correctness claim.
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';

CREATE TEMP TABLE identity39_context (
  league uuid, season uuid, users uuid[], members uuid[], players uuid[], year int,
  games uuid[], matchups uuid[], dates date[], nba_ids text[], alias_game uuid, bbref_id text
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.ok(condition boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF condition IS NOT TRUE THEN RAISE EXCEPTION 'Control fails: %',label; END IF; END $$;

DO $setup$
DECLARE c identity39_context%ROWTYPE; trial int; i int;
BEGIN
  c.league:=gen_random_uuid(); c.season:=gen_random_uuid(); c.alias_game:=gen_random_uuid();
  c.users:=ARRAY[gen_random_uuid(),gen_random_uuid()]; c.members:=ARRAY[gen_random_uuid(),gen_random_uuid()];
  c.players:=ARRAY[gen_random_uuid(),gen_random_uuid()]; c.games:=ARRAY[gen_random_uuid(),gen_random_uuid()];
  c.matchups:=ARRAY[gen_random_uuid(),gen_random_uuid()];
  FOR i IN 1..100 LOOP
    trial:=7500+floor(random()*1000)::int;
    IF NOT EXISTS(SELECT 1 FROM public.nba_games WHERE season_year=trial)
       AND NOT EXISTS(SELECT 1 FROM public.season_weeks WHERE season_year=trial)
       AND NOT EXISTS(SELECT 1 FROM public.league_seasons WHERE season_year=trial)
       AND NOT EXISTS(SELECT 1 FROM public.nba_games WHERE nba_game_id IN ('002'||trial||'001','002'||trial||'002')) THEN
      c.year:=trial; EXIT;
    END IF;
  END LOOP;
  PERFORM pg_temp.ok(c.year IS NOT NULL,'unused synthetic year allocation');
  c.dates:=ARRAY[make_date(c.year-1,10,15),make_date(c.year-1,10,22)];
  c.nba_ids:=ARRAY['002'||c.year||'001','002'||c.year||'002'];
  c.bbref_id:=to_char(c.dates[2],'YYYYMMDD')||'0BOS';
  INSERT INTO identity39_context SELECT c.*;
  FOR i IN 1..2 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(c.users[i],'authenticated','authenticated','identity39-'||c.users[i]||'@example.test','x',now(),'{}',
      jsonb_build_object('username','identity39_'||left(replace(c.users[i]::text,'-',''),18),'display_name','Synthetic identity control'),now(),now());
  END LOOP;
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,scoring_settings,playoff_start_week)
    VALUES(c.league,'Synthetic identity39 controls','identity39-'||c.league,c.users[1],'active','{"points":1}',3);
  FOR i IN 1..2 LOOP
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
      VALUES(c.members[i],c.league,c.users[i],CASE WHEN i=1 THEN 'commissioner'::league_member_role ELSE 'manager'::league_member_role END,'Owned '||i);
  END LOOP;
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current,playoff_start_week) VALUES(c.season,c.league,c.year,true,3);
  FOR i IN 1..2 LOOP
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team)
      VALUES(c.players[i],'Synthetic','Identity39 '||c.players[i],'PG',ARRAY['PG']::text[],'BOS');
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(c.year,i,c.dates[i],c.dates[i]+6);
    INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(c.games[i],c.nba_ids[i],c.year,i,c.dates[i],'BOS','NYK','Final');
    INSERT INTO public.matchups(id,league_id,league_season_id,week_number,end_week_number,home_member_id,away_member_id,matchup_type,is_finalized)
      VALUES(c.matchups[i],c.league,c.season,i,NULL,c.members[1],c.members[2],'regular_season',false);
  END LOOP;
  -- Temporary schema privileges permit actual service/anon/authenticated calls to the test helpers.
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role,anon,authenticated',pg_my_temp_schema()::regnamespace::text);
END $setup$;
GRANT SELECT ON identity39_context TO service_role,anon,authenticated;

CREATE FUNCTION pg_temp.stats(game uuid,home_points int) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$
SELECT jsonb_agg(jsonb_build_object('player_id',player,'game_id',game,'did_not_play',false,'minutes_played',30,
  'points',CASE WHEN ord=1 THEN home_points ELSE 7 END,'rebounds',0,'offensive_rebounds',0,'defensive_rebounds',0,
  'assists',0,'steals',0,'blocks',0,'turnovers',0,'personal_fouls',0,'field_goals_made',0,'field_goals_attempted',0,
  'three_pointers_made',0,'three_pointers_attempted',0,'free_throws_made',0,'free_throws_attempted',0,'plus_minus',0,
  'double_double',false,'triple_double',false) ORDER BY ord)
FROM identity39_context c CROSS JOIN unnest(c.players) WITH ORDINALITY p(player,ord)
$$;

CREATE FUNCTION pg_temp.snapshot() RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$
SELECT jsonb_build_object(
 'games',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM public.nba_games g WHERE g.season_year=c.year),
 'stats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id WHERE g.season_year=c.year),
 'weeks',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM public.season_weeks w WHERE w.season_year=c.year),
 'matchups',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM public.matchups m WHERE m.league_id=c.league),
 'standings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.standings s WHERE s.league_id=c.league),
 'certificates',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.week_number) FROM private.score_week_certificates s WHERE s.league_season_id=c.season),
 'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.scope) FROM private.score_input_revisions r
   WHERE r.scope IN ('league:'||c.league,'season:'||c.season,'calendar:'||c.year,'nba:'||c.year||':1','nba:'||c.year||':2',
      'lineup:'||c.season||':1','lineup:'||c.season||':2','result:'||c.season||':1','result:'||c.season||':2',
      'player:'||c.players[1],'player:'||c.players[2])))
FROM identity39_context c
$$;

CREATE FUNCTION pg_temp.denied(label text,statement text,states text[] DEFAULT ARRAY['55000']) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_state jsonb:=pg_temp.snapshot(); actual_state text; message text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
  END;
  PERFORM pg_temp.ok(actual_state=ANY(states),label||': expected denial, got '||coalesce(actual_state,'success')||' '||coalesce(message,''));
  PERFORM pg_temp.ok(pg_temp.snapshot() IS NOT DISTINCT FROM before_state,label||': exact owned state must stay unchanged');
  RAISE NOTICE 'PASS % SQLSTATE %',label,actual_state;
END $$;

CREATE FUNCTION pg_temp.token(week int) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$
SELECT private.score_input_token(c.season,week) FROM identity39_context c
$$;
CREATE FUNCTION pg_temp.finalize_request(week int,home_points int) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
SELECT format('SELECT public.finalize_score_week_atomic(%L::uuid,%L::uuid,%s,%L::jsonb,%L::jsonb,clock_timestamp(),clock_timestamp())',
 c.league,c.season,week,
 jsonb_build_array(jsonb_build_object('id',c.matchups[week],'home_points',home_points,'away_points',7,'winner_member_id',c.members[1],
   'home_max_possible_points',home_points,'away_max_possible_points',7,'score_read_started_at',clock_timestamp(),'input_token',private.score_input_token(c.season,week))),
 jsonb_build_array(jsonb_build_object('member_id',c.members[1],'wins',week,'losses',0,'ties',0,'points_for',home_points,'points_against',7,'max_possible_points',home_points,'waiver_priority',1),
   jsonb_build_object('member_id',c.members[2],'wins',0,'losses',week,'ties',0,'points_for',7,'points_against',home_points,'max_possible_points',7,'waiver_priority',2)))
FROM identity39_context c
$$;

-- Actual positive service-role calls prove the public entrypoints are executable.
SET LOCAL ROLE service_role;
DO $positive$
DECLARE c identity39_context%ROWTYPE; count_changed int; i int; imports jsonb;
BEGIN
  SELECT * INTO c FROM identity39_context;
  imports:=jsonb_build_array(jsonb_build_object('nba_game_id',c.nba_ids[2],'season_year',c.year,'game_date',c.dates[2],'home_team','BOS','away_team','NYK'));
  PERFORM public.assert_nba_game_imports(imports);
  PERFORM public.assert_nba_game_unambiguous(c.games[2]);
  FOR i IN 1..2 LOOP
    count_changed:=public.save_game_stats_atomic(c.games[i],c.nba_ids[i],pg_temp.stats(c.games[i],12),true);
    PERFORM pg_temp.ok(count_changed=2,'complete same-provider initial stats');
  END LOOP;
  count_changed:=public.save_game_stats_atomic(c.games[2],c.nba_ids[2],pg_temp.stats(c.games[2],12),true);
  PERFORM pg_temp.ok(count_changed=0,'exact same-provider retry writes no stat rows');
  count_changed:=public.save_game_stats_atomic(c.games[2],c.nba_ids[2],pg_temp.stats(c.games[2],13),true);
  PERFORM pg_temp.ok(count_changed=1,'valid same-provider points correction writes one changed row');
  FOR i IN 1..2 LOOP
    PERFORM public.capture_score_inputs(c.season,i);
    PERFORM public.update_score_points_atomic(c.league,c.season,i,jsonb_build_array(jsonb_build_object('id',c.matchups[i],'home_points',13,'away_points',7)));
    -- Read a current token after the actual points write, not a deliberately stale one.
    EXECUTE pg_temp.finalize_request(i,13);
  END LOOP;
END $positive$;
RESET ROLE;

-- Same-provider game retry and correction preserve admission for an existing identity.
DO $same_provider_game$
DECLARE c identity39_context%ROWTYPE;
BEGIN
 SELECT * INTO c FROM identity39_context;
 UPDATE public.nba_games SET nba_game_id=c.nba_ids[2] WHERE id=c.games[2];
 UPDATE public.nba_games SET game_date=c.dates[2]+1 WHERE id=c.games[2];
 PERFORM public.assert_nba_game_unambiguous(c.games[2]);
 UPDATE public.nba_games SET game_date=c.dates[2] WHERE id=c.games[2];
 PERFORM pg_temp.ok(EXISTS(SELECT 1 FROM public.nba_games WHERE id=c.games[2]
   AND nba_game_id=c.nba_ids[2] AND game_date=c.dates[2]),'same-provider game correction succeeds and returns to valid fixture date');
END $same_provider_game$;

-- Admission denials run through service role; direct game trigger controls run through owner writes.
SET LOCAL ROLE service_role;
DO $admission$
DECLARE c identity39_context%ROWTYPE;
BEGIN
 SELECT * INTO c FROM identity39_context;
 PERFORM pg_temp.denied('cross-provider stored candidate preflight',format('SELECT public.assert_nba_game_imports(%L::jsonb)',
   jsonb_build_array(jsonb_build_object('nba_game_id',c.bbref_id,'season_year',c.year,'game_date',c.dates[2],'home_team',' bos ','away_team','nyk'))));
 PERFORM pg_temp.denied('cross-provider intra-batch candidate preflight',format('SELECT public.assert_nba_game_imports(%L::jsonb)',
   jsonb_build_array(jsonb_build_object('nba_game_id','002'||c.year||'101','season_year',c.year,'game_date',c.dates[2]+2,'home_team','CHI','away_team','MIA'),
    jsonb_build_object('nba_game_id',to_char(c.dates[2]+2,'YYYYMMDD')||'0CHI','season_year',c.year,'game_date',c.dates[2]+2,'home_team','CHI','away_team','MIA'))));
END $admission$;
RESET ROLE;
DO $trigger$
DECLARE c identity39_context%ROWTYPE; extra uuid; i int; d date; home text; away text; provider text;
BEGIN
 SELECT * INTO c FROM identity39_context;
 PERFORM pg_temp.denied('direct cross-provider game insertion',format('INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status) VALUES(%L::uuid,%L,%s,2,%L::date,%L,%L,%L)',
   c.alias_game,c.bbref_id,c.year,c.dates[2],'BOS','NYK','Final'));
 PERFORM pg_temp.denied('cross-provider ID replacement',format('UPDATE public.nba_games SET nba_game_id=%L WHERE id=%L::uuid',c.bbref_id,c.games[2]));
 -- One multi-row statement includes a valid row then a conflicting candidate. It must roll back both rows.
 PERFORM pg_temp.denied('direct multi-row candidate rollback',format('INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status) VALUES(%L::uuid,%L,%s,2,%L::date,%L,%L,%L),(%L::uuid,%L,%s,2,%L::date,%L,%L,%L)',
  gen_random_uuid(),to_char(c.dates[2]+1,'YYYYMMDD')||'0CHI',c.year,c.dates[2]+1,'CHI','MIA','Final',
  gen_random_uuid(),c.bbref_id,c.year,c.dates[2],'BOS','NYK','Final'));
 -- Distinct date, reversed ordered teams, and different teams all remain admissible.
 FOR i IN 1..3 LOOP
   extra:=gen_random_uuid(); d:=CASE WHEN i=1 THEN c.dates[2]+1 ELSE c.dates[2] END;
   home:=CASE WHEN i=2 THEN 'NYK' WHEN i=3 THEN 'CHI' ELSE 'BOS' END;
   away:=CASE WHEN i=2 THEN 'BOS' WHEN i=3 THEN 'MIA' ELSE 'NYK' END;
   provider:=to_char(d,'YYYYMMDD')||'0'||home;
   PERFORM public.assert_nba_game_imports(jsonb_build_array(jsonb_build_object('nba_game_id',provider,'season_year',c.year,'game_date',d,'home_team',home,'away_team',away)));
   INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status) VALUES(extra,provider,c.year,2,d,home,away,'Final');
   PERFORM public.assert_nba_game_unambiguous(extra);
 END LOOP;
END $trigger$;

-- Historical setup only: represent a duplicate already present before migration39.
-- Disable ONLY the new identity trigger, insert ONLY this fresh synthetic alias, then re-enable it.
-- All revision/completion/other guards remain active; everything stays in this transaction.
ALTER TABLE public.nba_games DISABLE TRIGGER guard_nba_game_identity;
DO $historical$
DECLARE c identity39_context%ROWTYPE;
BEGIN
 SELECT * INTO c FROM identity39_context;
 INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,stats_synced_at)
 VALUES(c.alias_game,c.bbref_id,c.year,2,c.dates[2],'BOS','NYK','Final',clock_timestamp());
 INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,game_date,points,minutes_played,did_not_play)
 SELECT player,c.alias_game,c.year,2,c.dates[2],12,30,false FROM unnest(c.players) player;
END $historical$;
ALTER TABLE public.nba_games ENABLE TRIGGER guard_nba_game_identity;
DO $calendar_positive$
DECLARE c identity39_context%ROWTYPE;
BEGIN
 SELECT * INTO c FROM identity39_context;
 -- Migration40 is present in the current checkout. Its calendar guard must accept this fixture.
 -- Later 55000 denials therefore exercise unresolved identity rather than an invalid calendar.
 PERFORM private.assert_score_calendar(c.season,1);
 PERFORM private.assert_score_calendar(c.season,2);
END $calendar_positive$;

SET LOCAL ROLE service_role;
DO $existing$
DECLARE c identity39_context%ROWTYPE; stable_token jsonb;
BEGIN
 SELECT * INTO c FROM identity39_context;
 stable_token:=pg_temp.token(2);
 PERFORM pg_temp.ok(stable_token IS NOT NULL,'all current duplicate-state revision keys exist');
 PERFORM pg_temp.denied('existing duplicate stat completion',format('SELECT public.save_game_stats_atomic(%L::uuid,%L,%L::jsonb,true)',c.games[2],c.nba_ids[2],pg_temp.stats(c.games[2],999)));
 PERFORM pg_temp.denied('existing duplicate capture',format('SELECT public.capture_score_inputs(%L::uuid,2)',c.season));
 PERFORM pg_temp.denied('existing duplicate live points',format('SELECT public.update_score_points_atomic(%L::uuid,%L::uuid,2,%L::jsonb)',c.league,c.season,
   jsonb_build_array(jsonb_build_object('id',c.matchups[2],'home_points',999,'away_points',1))));
 PERFORM pg_temp.denied('existing duplicate final certificate with CURRENT token',pg_temp.finalize_request(2,999));
 PERFORM pg_temp.ok(pg_temp.token(2)=stable_token,'duplicate denials preserve the actual current input token');
END $existing$;
RESET ROLE;
DO $private_guard$
DECLARE c identity39_context%ROWTYPE; current_token jsonb;
BEGIN
 SELECT * INTO c FROM identity39_context; current_token:=pg_temp.token(2);
 PERFORM pg_temp.ok(current_token=private.score_input_token(c.season,2),'lock_current test uses current duplicate-state token');
 PERFORM pg_temp.denied('existing duplicate lock_current with CURRENT token',format('SELECT private.lock_current_score_inputs(%L::uuid,2,%L::jsonb)',c.season,current_token));
 -- Week one excludes the week-two ambiguity. It must remain usable.
 PERFORM pg_temp.ok(private.lock_current_score_inputs(c.season,1,pg_temp.token(1)),'unrelated earlier week stays valid');
END $private_guard$;
SET LOCAL ROLE service_role;
DO $unrelated$
DECLARE c identity39_context%ROWTYPE; changed int;
BEGIN
 SELECT * INTO c FROM identity39_context;
 PERFORM public.assert_nba_game_unambiguous(c.games[1]);
 changed:=public.save_game_stats_atomic(c.games[1],c.nba_ids[1],pg_temp.stats(c.games[1],14),true);
 PERFORM pg_temp.ok(changed=1,'unrelated-week valid same-provider correction succeeds');
 PERFORM public.capture_score_inputs(c.season,1);
 PERFORM public.update_score_points_atomic(c.league,c.season,1,jsonb_build_array(jsonb_build_object('id',c.matchups[1],'home_points',14,'away_points',7)));
 EXECUTE pg_temp.finalize_request(1,14);
END $unrelated$;
RESET ROLE;

-- Actual anon/authenticated execution denials, rather than metadata-only ACL checks.
DO $acl_metadata$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['public.assert_nba_game_imports(jsonb)','public.assert_nba_game_unambiguous(uuid)',
  'public.save_game_stats_atomic(uuid,text,jsonb,boolean)','public.capture_score_inputs(uuid,integer)',
  'public.update_score_points_atomic(uuid,uuid,integer,jsonb)','public.finalize_score_week_atomic(uuid,uuid,integer,jsonb,jsonb,timestamp with time zone,timestamp with time zone)'] LOOP
   PERFORM pg_temp.ok(has_function_privilege('service_role',name,'EXECUTE'),'service ACL '||name);
   PERFORM pg_temp.ok(NOT has_function_privilege('anon',name,'EXECUTE'),'anon ACL '||name);
   PERFORM pg_temp.ok(NOT has_function_privilege('authenticated',name,'EXECUTE'),'authenticated ACL '||name);
 END LOOP;
END $acl_metadata$;
CREATE FUNCTION pg_temp.acl_calls() RETURNS void LANGUAGE plpgsql AS $$
DECLARE c identity39_context%ROWTYPE;
BEGIN
 SELECT * INTO c FROM identity39_context;
 PERFORM pg_temp.denied('ACL admission '||current_user,'SELECT public.assert_nba_game_imports(''[]''::jsonb)',ARRAY['42501']);
 PERFORM pg_temp.denied('ACL game guard '||current_user,format('SELECT public.assert_nba_game_unambiguous(%L::uuid)',c.games[1]),ARRAY['42501']);
 PERFORM pg_temp.denied('ACL complete stats '||current_user,format('SELECT public.save_game_stats_atomic(%L::uuid,%L,%L::jsonb,true)',c.games[1],c.nba_ids[1],pg_temp.stats(c.games[1],14)),ARRAY['42501']);
 PERFORM pg_temp.denied('ACL capture '||current_user,format('SELECT public.capture_score_inputs(%L::uuid,1)',c.season),ARRAY['42501']);
 PERFORM pg_temp.denied('ACL live points '||current_user,format('SELECT public.update_score_points_atomic(%L::uuid,%L::uuid,1,''[]''::jsonb)',c.league,c.season),ARRAY['42501']);
 PERFORM pg_temp.denied('ACL final certificate '||current_user,pg_temp.finalize_request(1,14),ARRAY['42501']);
END $$;
SET LOCAL ROLE anon;
SELECT pg_temp.acl_calls();
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.acl_calls();
RESET ROLE;

SELECT 'C102 identity39 controls reach assertions; all writes are about to roll back' AS result;
ROLLBACK;
