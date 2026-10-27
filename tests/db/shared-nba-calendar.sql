-- Local PostgreSQL integration controls; all changes roll back.
-- Fixture administrator; ON_ERROR_STOP=1; migrations 39 and 40 installed.
-- Everything, including scoped constraints and auth fixtures, rolls back.
BEGIN;

CREATE FUNCTION pg_temp.must(p_ok boolean,p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Control failed: %',p_label USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE FUNCTION pg_temp.call_as(p_role text,p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_code text; v_message text;
BEGIN
  PERFORM set_config('request.jwt.claims',jsonb_build_object('role',p_role)::text,true);
  EXECUTE format('SET LOCAL ROLE %I',p_role);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE,v_message=MESSAGE_TEXT;
    RAISE NOTICE 'RPC rejection [%]: %',v_code,v_message;
  END;
  EXECUTE 'RESET ROLE';
  RETURN v_code;
END;
$$;

CREATE FUNCTION pg_temp.calendar_state(p_years int[])
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'games',COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY id)
      FROM public.nba_games g WHERE season_year=ANY(p_years)),'[]'::jsonb),
    'stats',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY id)
      FROM public.player_game_stats s WHERE season_year=ANY(p_years)
        OR game_id IN(SELECT id FROM public.nba_games WHERE season_year=ANY(p_years))),'[]'::jsonb),
    'weeks',COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY id)
      FROM public.season_weeks w WHERE season_year=ANY(p_years)),'[]'::jsonb),
    'calendar_corrections',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY game_id,season_year,game_date)
      FROM public.game_calendar_corrections c WHERE season_year=ANY(p_years)
        OR game_id IN(SELECT id FROM public.nba_games WHERE season_year=ANY(p_years))),'[]'::jsonb),
    'matchups',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY id)
      FROM public.matchups m WHERE league_season_id IN
        (SELECT id FROM public.league_seasons WHERE season_year=ANY(p_years))),'[]'::jsonb)
  );
$$;

CREATE FUNCTION pg_temp.game(p_year int,p_index int,p_date date,p_week int,p_status text,p_provider text DEFAULT 'nba')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('nba_game_id',CASE WHEN p_provider='bbref'
      THEN to_char(p_date,'YYYYMMDD')||'0XAA'
      ELSE '002'||p_year::text||lpad(p_index::text,3,'0') END,
    'season_year',p_year,'game_date',p_date,'week_number',p_week,
    'home_team','XAA','away_team','XBB','status',p_status);
$$;

CREATE FUNCTION pg_temp.week(p_year int,p_week int,p_start date,p_end date)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('season_year',p_year,'week_number',p_week,
    'week_start',p_start,'week_end',p_end);
$$;

DO $$
DECLARE
  v_year int;
  v_day date;
  v_years int[];
  v_player uuid:=gen_random_uuid();
  v_user uuid:=gen_random_uuid();
  v_other_user uuid:=gen_random_uuid();
  v_league uuid:=gen_random_uuid();
  v_season uuid:=gen_random_uuid();
  v_member uuid:=gen_random_uuid();
  v_other_member uuid:=gen_random_uuid();
  v_matchup uuid:=gen_random_uuid();
  v_bbref jsonb;
  v_nba jsonb;
  v_games jsonb;
  v_weeks jsonb;
  v_sql text;
  v_code text;
  v_role text;
  v_game_id uuid;
  v_stat_id uuid;
  v_before jsonb;
  v_before_stat jsonb;
  v_constraint text:='calendar_control_'||replace(gen_random_uuid()::text,'-','');
BEGIN
  -- Select empty synthetic years. Never delete or rewrite an existing fixture.
  SELECT candidate INTO v_year FROM generate_series(7000,8900) candidate
  WHERE NOT EXISTS(SELECT 1 FROM public.nba_games WHERE season_year BETWEEN candidate AND candidate+7)
    AND NOT EXISTS(SELECT 1 FROM public.season_weeks WHERE season_year BETWEEN candidate AND candidate+7)
    AND NOT EXISTS(SELECT 1 FROM public.league_seasons WHERE season_year BETWEEN candidate AND candidate+7)
    AND NOT EXISTS(SELECT 1 FROM public.nba_games g,
      generate_series(candidate,candidate+7) fixture_year
      WHERE g.nba_game_id LIKE '002'||fixture_year::text||'%'
        OR g.nba_game_id LIKE fixture_year::text||'%')
  ORDER BY candidate LIMIT 1;
  PERFORM pg_temp.must(v_year IS NOT NULL,'eight empty synthetic years are available');
  v_years:=ARRAY[v_year,v_year+1,v_year+2,v_year+3,v_year+4,v_year+5,v_year+6,v_year+7];
  v_day:=make_date(v_year,1,1);
  INSERT INTO public.players(id,first_name,last_name,nba_team,position,eligible_positions)
  VALUES(v_player,'Calendar',v_player::text,'XAA','PG',ARRAY['PG']);

  -- Different dates are distinct real games, not guessed provider aliases.
  v_bbref:=pg_temp.game(v_year,1,v_day,1,'Scheduled','bbref');
  v_nba:=pg_temp.game(v_year,2,v_day+8,1,'InProgress');
  v_games:=jsonb_build_array(v_bbref);
  -- Scheduled is left of the supplied bounds; InProgress later extends their right side.
  v_weeks:=jsonb_build_array(pg_temp.week(v_year,1,v_day+1,v_day+6));
  v_code:=pg_temp.call_as('service_role',format(
    'SELECT public.publish_nba_schedule_atomic(%s,%L::jsonb,%L::jsonb)',v_year,v_games,v_weeks));
  PERFORM pg_temp.must(v_code IS NULL,'service role initializes a full schedule');
  v_code:=pg_temp.call_as('service_role',format(
    'SELECT public.publish_nba_schedule_atomic(%s,%L::jsonb,%L::jsonb)',v_year,
    jsonb_build_array(v_nba),jsonb_build_array(pg_temp.week(v_year,1,v_day+2,v_day+2))));
  PERFORM pg_temp.must(v_code IS NULL,'second provider adds a different retained date');
  PERFORM pg_temp.must((SELECT count(*)=2 FROM public.nba_games WHERE season_year=v_year)
    AND EXISTS(SELECT 1 FROM public.nba_games WHERE nba_game_id=v_bbref->>'nba_game_id' AND status='Scheduled')
    AND EXISTS(SELECT 1 FROM public.nba_games WHERE nba_game_id=v_nba->>'nba_game_id' AND status='InProgress'),
    'Scheduled and InProgress games both survive the provider union');
  PERFORM pg_temp.must((SELECT week_start=v_day AND week_end=v_day+8 FROM public.season_weeks
    WHERE season_year=v_year AND week_number=1),'Scheduled and InProgress extend bounds; narrow provider bounds cannot truncate them');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points)
  SELECT v_player,id,v_year,1,17 FROM public.nba_games WHERE season_year=v_year;
  v_before:=pg_temp.calendar_state(v_years);
  -- Positive retries can update game.updated_at. They must preserve dates, weeks, stats, and identity.
  FOREACH v_games IN ARRAY ARRAY[jsonb_build_array(v_bbref),jsonb_build_array(v_nba)] LOOP
    v_code:=pg_temp.call_as('service_role',format(
      'SELECT public.publish_nba_schedule_atomic(%s,%L::jsonb,%L::jsonb)',v_year,v_games,'[]'::jsonb));
    PERFORM pg_temp.must(v_code IS NULL,'each provider retry succeeds without deleting the other provider');
    PERFORM pg_temp.must((SELECT count(*)=2 FROM public.nba_games WHERE season_year=v_year)
      AND EXISTS(SELECT 1 FROM public.nba_games WHERE nba_game_id=v_bbref->>'nba_game_id' AND game_date=v_day AND week_number=1)
      AND EXISTS(SELECT 1 FROM public.nba_games WHERE nba_game_id=v_nba->>'nba_game_id' AND game_date=v_day+8 AND week_number=1),
      'both distinct provider dates survive a partial retry');
    PERFORM pg_temp.must(pg_temp.calendar_state(v_years)->'stats'=v_before->'stats'
      AND pg_temp.calendar_state(v_years)->'weeks'=v_before->'weeks',
      'provider retry leaves existing stats and week bounds exact');
  END LOOP;

  -- Actual access checks. A schema or validation error cannot replace permission denied.
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    v_before:=pg_temp.calendar_state(v_years);
    v_code:=pg_temp.call_as(v_role,format(
      'SELECT public.publish_nba_schedule_atomic(%s,%L::jsonb,%L::jsonb)',v_year,jsonb_build_array(v_nba),'[]'::jsonb));
    PERFORM pg_temp.must(v_code='42501',v_role||' cannot publish the calendar');
    PERFORM pg_temp.must(pg_temp.calendar_state(v_years)=v_before,'denied publish leaves exact inputs unchanged');
    v_code:=pg_temp.call_as(v_role,format('SELECT public.rebuild_nba_calendar_atomic(%s)',v_year));
    PERFORM pg_temp.must(v_code='42501',v_role||' cannot rebuild the calendar');
    PERFORM pg_temp.must(pg_temp.calendar_state(v_years)=v_before,'denied rebuild leaves exact inputs unchanged');
  END LOOP;

  -- Wrong rebucketing and overlap must reject before touching any rows or timestamps.
  v_before:=pg_temp.calendar_state(v_years);
  v_code:=pg_temp.call_as('service_role',format(
    'SELECT public.publish_nba_schedule_atomic(%s,%L::jsonb,%L::jsonb)',v_year,
    jsonb_build_array(v_nba||jsonb_build_object('week_number',2)),
    jsonb_build_array(pg_temp.week(v_year,2,v_day+8,v_day+8))));
  PERFORM pg_temp.must(v_code='55000','a retained valid week cannot be rebucketed by a partial schedule');
  PERFORM pg_temp.must(pg_temp.calendar_state(v_years)=v_before,'wrong rebucket preserves exact games, stats, weeks, and results');
  v_code:=pg_temp.call_as('service_role',format(
    'SELECT public.publish_nba_schedule_atomic(%s,%L::jsonb,%L::jsonb)',v_year,'[]'::jsonb,
    jsonb_build_array(pg_temp.week(v_year,2,v_day+8,v_day+10))));
  PERFORM pg_temp.must(v_code='55000','inclusive boundary overlap rejects');
  PERFORM pg_temp.must(pg_temp.calendar_state(v_years)=v_before,'overlap rejects without even changing timestamps');

  -- A date correction within one week must also correct the stored stat date.
  SELECT id INTO v_game_id FROM public.nba_games WHERE nba_game_id=v_nba->>'nba_game_id';
  SELECT id,to_jsonb(s) INTO v_stat_id,v_before_stat FROM public.player_game_stats s WHERE game_id=v_game_id;
  v_nba:=v_nba||jsonb_build_object('game_date',v_day+7);
  v_code:=pg_temp.call_as('service_role',format(
    'SELECT public.publish_nba_schedule_atomic(%s,%L::jsonb,%L::jsonb)',v_year,jsonb_build_array(v_nba),'[]'::jsonb));
  PERFORM pg_temp.must(v_code IS NULL,'same-provider date correction within the valid week succeeds');
  PERFORM pg_temp.must((SELECT game_date=v_day+7 AND season_year=v_year AND week_number=1 AND points=17
    FROM public.player_game_stats WHERE id=v_stat_id),'stat calendar fields follow the corrected parent date');

  -- Explicit service season corrections are supported by the existing parent trigger.
  -- The earlier rejection requirement was ungrounded; verify all linked dates instead.
  BEGIN
    v_before:=pg_temp.calendar_state(v_years);
    v_code:=pg_temp.call_as('service_role',format(
      'SELECT public.publish_nba_schedule_atomic(%s,%L::jsonb,%L::jsonb)',v_year+7,
      jsonb_build_array(v_nba||jsonb_build_object('season_year',v_year+7)),
      jsonb_build_array(pg_temp.week(v_year+7,1,v_day,v_day+8))));
    PERFORM pg_temp.must(v_code IS NULL,'authorized season correction stays supported');
    PERFORM pg_temp.must((SELECT season_year=v_year+7 AND game_date=v_day+7 AND week_number=1 FROM public.nba_games WHERE id=v_game_id)
      AND (SELECT season_year=v_year+7 AND game_date=v_day+7 AND week_number=1 AND points=17 FROM public.player_game_stats WHERE id=v_stat_id),
      'season correction updates parent and stat calendar fields without losing points');
    PERFORM pg_temp.must(EXISTS(SELECT 1 FROM public.game_calendar_corrections WHERE game_id=v_game_id AND season_year=v_year)
      AND EXISTS(SELECT 1 FROM public.game_calendar_corrections WHERE game_id=v_game_id AND season_year=v_year+7),
      'season correction retains both affected calendar revision locations');
    RAISE EXCEPTION 'Rollback explicit season correction control' USING ERRCODE='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;

  -- Old truncated calendar: a Scheduled prior-week game still blocks regular-season scoring.
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
    raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','x',now(),'{}','{}',now(),now()),
    (v_other_user,'authenticated','authenticated',v_other_user||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status)
  VALUES(v_league,'Calendar Control',v_league::text,v_user,'active');
  INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
  VALUES(v_member,v_league,v_user,'commissioner','Home'),(v_other_member,v_league,v_other_user,'manager','Away');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
  VALUES(v_season,v_league,v_year+1,true);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points)
  VALUES(v_matchup,v_league,v_season,2,v_member,v_other_member,20,60);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
  VALUES(v_year+1,1,make_date(v_year+1,1,1),make_date(v_year+1,1,3)),
    (v_year+1,2,make_date(v_year+1,1,8),make_date(v_year+1,1,14));
  INSERT INTO public.nba_games(nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
  SELECT row->>'nba_game_id',v_year+1,(row->>'game_date')::date,1,'XAA','XBB','Scheduled'
  FROM jsonb_array_elements(jsonb_build_array(pg_temp.game(v_year+1,1,make_date(v_year+1,1,7),1,'Scheduled'))) row;
  v_before:=pg_temp.calendar_state(v_years);
  v_code:=pg_temp.call_as('service_role',format('SELECT public.capture_score_inputs(%L::uuid,2)',v_season));
  PERFORM pg_temp.must(v_code='55000','regular-season score capture rejects missing prior-week calendar coverage');
  PERFORM pg_temp.must(pg_temp.calendar_state(v_years)=v_before,'score guard preserves exact games, stats, weeks, and 20-to-60 result');

  -- Existing unique ranges correct provisional game and stat weeks together.
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
  VALUES(v_year+2,1,make_date(v_year+2,1,1),make_date(v_year+2,1,7)),
    (v_year+2,2,make_date(v_year+2,1,8),make_date(v_year+2,1,14));
  v_games:=jsonb_build_array(pg_temp.game(v_year+2,1,make_date(v_year+2,1,3),9,'Scheduled'),
    pg_temp.game(v_year+2,2,make_date(v_year+2,1,9),9,'InProgress'));
  INSERT INTO public.nba_games(nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
  SELECT row->>'nba_game_id',v_year+2,(row->>'game_date')::date,9,'XAA','XBB',row->>'status'
    FROM jsonb_array_elements(v_games) row;
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points)
  SELECT v_player,id,v_year+2,9,23 FROM public.nba_games WHERE season_year=v_year+2;
  -- Force failure after the game UPDATE, when the stat UPDATE reaches week one.
  EXECUTE format('ALTER TABLE public.player_game_stats ADD CONSTRAINT %I CHECK(season_year<>%s OR week_number<>1) NOT VALID',v_constraint,v_year+2);
  v_before:=pg_temp.calendar_state(v_years);
  v_code:=pg_temp.call_as('service_role',format('SELECT public.rebuild_nba_calendar_atomic(%s)',v_year+2));
  PERFORM pg_temp.must(v_code='23514','late stat constraint forces rebuild rollback');
  PERFORM pg_temp.must(pg_temp.calendar_state(v_years)=v_before,'failed rebuild rolls back game changes before stat failure');
  EXECUTE format('ALTER TABLE public.player_game_stats DROP CONSTRAINT %I',v_constraint);
  v_code:=pg_temp.call_as('service_role',format('SELECT public.rebuild_nba_calendar_atomic(%s)',v_year+2));
  PERFORM pg_temp.must(v_code IS NULL,'service role rebuilds uniquely covered provisional weeks');
  PERFORM pg_temp.must((SELECT count(*)=2 FROM public.nba_games WHERE season_year=v_year+2
    AND week_number=CASE WHEN game_date=make_date(v_year+2,1,3) THEN 1 ELSE 2 END)
    AND (SELECT count(*)=2 FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
      WHERE g.season_year=v_year+2 AND s.week_number=g.week_number AND s.points=23),
    'both Scheduled and InProgress game/stat weeks correct without losing points');
  PERFORM pg_temp.must(pg_temp.calendar_state(v_years)->'weeks'=v_before->'weeks','rebuild preserves known range bounds exactly');

  -- Invalid existing coverage must reject before correcting any provisional rows.
  BEGIN
    UPDATE public.nba_games SET week_number=9 WHERE season_year=v_year+2;
    INSERT INTO public.nba_games(nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
    VALUES('002'||(v_year+2)::text||'003',v_year+2,make_date(v_year+2,1,20),9,'XAA','XBB','InProgress');
    v_before:=pg_temp.calendar_state(v_years);
    v_code:=pg_temp.call_as('service_role',format('SELECT public.rebuild_nba_calendar_atomic(%s)',v_year+2));
    PERFORM pg_temp.must(v_code='55000','outside existing ranges rejects rebuild');
    PERFORM pg_temp.must(pg_temp.calendar_state(v_years)=v_before,'outside-range denial preserves exact rows');
    RAISE EXCEPTION 'Rollback outside-range fixture' USING ERRCODE='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;
  BEGIN
    UPDATE public.nba_games SET week_number=9 WHERE season_year=v_year+2;
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(v_year+2,3,make_date(v_year+2,1,2),make_date(v_year+2,1,4));
    v_before:=pg_temp.calendar_state(v_years);
    v_code:=pg_temp.call_as('service_role',format('SELECT public.rebuild_nba_calendar_atomic(%s)',v_year+2));
    PERFORM pg_temp.must(v_code='55000','ambiguous existing ranges reject rebuild');
    PERFORM pg_temp.must(pg_temp.calendar_state(v_years)=v_before,'ambiguous-range denial preserves exact rows');
    RAISE EXCEPTION 'Rollback ambiguous-range fixture' USING ERRCODE='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;

  -- Enumeration cannot establish completeness. Only a verified schedule supplies week bounds.
  INSERT INTO public.nba_games(nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
  VALUES('002'||(v_year+3)::text||'001',v_year+3,make_date(v_year+3,1,1),9,'XAA','XBB','Scheduled'),
    ('002'||(v_year+3)::text||'002',v_year+3,make_date(v_year+3,1,9),9,'XAA','XBB','InProgress');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points)
  SELECT v_player,id,v_year+3,9,31 FROM public.nba_games WHERE season_year=v_year+3;
  v_before:=pg_temp.calendar_state(v_years);
  v_code:=pg_temp.call_as('service_role',format('SELECT public.rebuild_nba_calendar_atomic(%s)',v_year+3));
  PERFORM pg_temp.must(v_code='55000','default retry cannot initialize from partial retained history');
  PERFORM pg_temp.must(pg_temp.calendar_state(v_years)=v_before,'retry initialization denial preserves exact inputs');
  v_games:=jsonb_build_array(pg_temp.game(v_year+3,1,make_date(v_year+3,1,1),1,'Scheduled'),
    pg_temp.game(v_year+3,2,make_date(v_year+3,1,9),2,'InProgress'));
  v_weeks:=jsonb_build_array(pg_temp.week(v_year+3,1,make_date(v_year+3,1,1),make_date(v_year+3,1,7)),
    pg_temp.week(v_year+3,2,make_date(v_year+3,1,8),make_date(v_year+3,1,14)));
  v_code:=pg_temp.call_as('service_role',format('SELECT public.publish_nba_schedule_atomic(%s,%L::jsonb,%L::jsonb)',v_year+3,v_games,v_weeks));
  PERFORM pg_temp.must(v_code IS NULL,'verified complete schedule initializes the empty calendar');
  v_code:=pg_temp.call_as('service_role',format('SELECT public.rebuild_nba_calendar_atomic(%s)',v_year+3));
  PERFORM pg_temp.must(v_code IS NULL,'enumeration accepts the published complete calendar');
  PERFORM pg_temp.must((SELECT count(*)=2 FROM public.season_weeks WHERE season_year=v_year+3)
    AND (SELECT count(*)=2 FROM public.nba_games WHERE season_year=v_year+3 AND week_number IN(1,2))
    AND (SELECT count(*)=2 FROM public.player_game_stats WHERE season_year=v_year+3 AND week_number IN(1,2) AND points=31),
    'initialization writes game/stat week numbers and both calendar ranges');
  v_before:=pg_temp.calendar_state(v_years);
  v_code:=pg_temp.call_as('service_role',format('SELECT public.rebuild_nba_calendar_atomic(%s)',v_year+4));
  PERFORM pg_temp.must(v_code IS NULL AND pg_temp.calendar_state(v_years)=v_before,'a truly empty season is a harmless retry');

  -- Force publish failure at its last write, after game and stat changes.
  INSERT INTO public.nba_games(nba_game_id,season_year,game_date,week_number,home_team,away_team,status)
  VALUES('002'||(v_year+5)::text||'001',v_year+5,make_date(v_year+5,1,1),9,'XAA','XBB','Scheduled');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points)
  SELECT v_player,id,v_year+5,9,41 FROM public.nba_games WHERE season_year=v_year+5;
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
  VALUES(v_year+5,1,make_date(v_year+5,1,1),make_date(v_year+5,1,3));
  v_games:=jsonb_build_array(pg_temp.game(v_year+5,1,make_date(v_year+5,1,1),1,'InProgress'),
    pg_temp.game(v_year+5,2,make_date(v_year+5,1,9),2,'Scheduled'));
  v_weeks:=jsonb_build_array(pg_temp.week(v_year+5,1,make_date(v_year+5,1,1),make_date(v_year+5,1,3)),
    pg_temp.week(v_year+5,2,make_date(v_year+5,1,8),make_date(v_year+5,1,14)));
  EXECUTE format('ALTER TABLE public.season_weeks ADD CONSTRAINT %I CHECK(season_year<>%s OR week_number<>2) NOT VALID',v_constraint,v_year+5);
  v_before:=pg_temp.calendar_state(v_years);
  v_sql:=format('SELECT public.publish_nba_schedule_atomic(%s,%L::jsonb,%L::jsonb)',v_year+5,v_games,v_weeks);
  v_code:=pg_temp.call_as('service_role',v_sql);
  PERFORM pg_temp.must(v_code='23514','late week constraint forces the actual publish to fail');
  PERFORM pg_temp.must(pg_temp.calendar_state(v_years)=v_before,'full publish rollback restores game status, provisional stat week, and all calendar rows');
  EXECUTE format('ALTER TABLE public.season_weeks DROP CONSTRAINT %I',v_constraint);
  v_code:=pg_temp.call_as('service_role',v_sql);
  PERFORM pg_temp.must(v_code IS NULL,'identical publish succeeds after only the forced constraint is removed');
  PERFORM pg_temp.must((SELECT count(*)=2 FROM public.nba_games WHERE season_year=v_year+5)
    AND (SELECT week_number=1 AND points=41 FROM public.player_game_stats WHERE season_year=v_year+5),
    'late failure control reaches both earlier writes on its positive counterpart');

  -- A real date correction crosses to another uniquely recorded existing week.
  -- This differs from the unchanged-date wrong-rebucket denial above.
  BEGIN
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(v_year,2,v_day+9,v_day+15);
    v_before:=pg_temp.calendar_state(v_years);
    v_games:=jsonb_build_array(v_nba||jsonb_build_object('game_date',v_day+10,'week_number',2));
    v_code:=pg_temp.call_as('service_role',format(
      'SELECT public.publish_nba_schedule_atomic(%s,%L::jsonb,%L::jsonb)',v_year,v_games,'[]'::jsonb));
    PERFORM pg_temp.must(v_code IS NULL,'same-provider reschedule reaches its uniquely recorded destination week');
    PERFORM pg_temp.must((SELECT game_date=v_day+10 AND week_number=2
      FROM public.nba_games WHERE id=v_game_id)
      AND (SELECT game_date=v_day+10 AND week_number=2 AND points=17
        FROM public.player_game_stats WHERE id=v_stat_id),
      'legitimate reschedule corrects game and stat calendar fields atomically');
    PERFORM pg_temp.must(pg_temp.calendar_state(v_years)->'weeks'=v_before->'weeks',
      'reschedule preserves exact source and destination week bounds');
    PERFORM pg_temp.must(EXISTS(SELECT 1 FROM public.nba_games
      WHERE nba_game_id=v_bbref->>'nba_game_id' AND game_date=v_day AND week_number=1),
      'reschedule preserves the other provider game in its recorded week');
    RAISE EXCEPTION 'Rollback valid-reschedule positive fixture' USING ERRCODE='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;

  RAISE NOTICE 'Calendar controls reach every assertion; all synthetic data and scoped constraints roll back.';
END;
$$;
ROLLBACK;
