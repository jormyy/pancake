BEGIN;
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE pick_invariant_failures(label text NOT NULL) ON COMMIT DROP;

CREATE FUNCTION pg_temp.draft_calendar_year(p_nba_season int) RETURNS int LANGUAGE sql AS $$
  SELECT extract(year FROM max(week.week_end))::int FROM public.season_weeks week WHERE week.season_year=p_nba_season
$$;

CREATE FUNCTION pg_temp.check_picks(p_league uuid, p_span int, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_season int;
  v_earlier boolean;
  v_first int;
  v_last int;
  v_member record;
BEGIN
  SELECT season.season_year,EXISTS(SELECT 1 FROM public.league_seasons earlier
    WHERE earlier.league_id=season.league_id AND earlier.season_year<season.season_year)
  INTO v_season,v_earlier FROM public.league_seasons season WHERE season.league_id=p_league AND season.is_current;
  v_first := pg_temp.draft_calendar_year(CASE WHEN v_earlier THEN v_season-1 ELSE v_season END);
  v_last := pg_temp.draft_calendar_year(v_season)+p_span-1;
  FOR v_member IN
    SELECT member.team_name,count(pick.id) AS picks,count(DISTINCT (pick.season_year,pick.round)) AS slots,
      min(pick.season_year) AS first_year,max(pick.season_year) AS last_year,
      bool_and(pick.round BETWEEN 1 AND 3) AS rounds_ok
    FROM public.league_members member
    LEFT JOIN public.draft_picks pick ON pick.original_owner_id=member.id AND pick.league_id=member.league_id AND NOT pick.is_used
    WHERE member.league_id=p_league GROUP BY member.id,member.team_name
  LOOP
    IF v_member.picks=0 THEN
      INSERT INTO pick_invariant_failures VALUES(format('%s: %s has no picks',p_label,v_member.team_name));
      CONTINUE;
    END IF;
    IF v_member.picks<>v_member.slots OR NOT v_member.rounds_ok OR v_member.picks<>3*(v_member.last_year-v_member.first_year+1) THEN
      INSERT INTO pick_invariant_failures VALUES(format('%s: %s is missing pick years or rounds between %s and %s (%s picks)',
        p_label,v_member.team_name,v_member.first_year,v_member.last_year,v_member.picks));
    END IF;
    IF v_member.first_year IS DISTINCT FROM v_first OR v_member.last_year IS DISTINCT FROM v_last THEN
      INSERT INTO pick_invariant_failures VALUES(format('%s: %s holds draft years %s-%s; league season %s drafts in %s-%s',
        p_label,v_member.team_name,v_member.first_year,v_member.last_year,v_season,v_first,v_last));
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION pg_temp.new_league(p_label text, p_members int, OUT league uuid, OUT span int) LANGUAGE plpgsql AS $$
DECLARE
  v_users uuid[] := '{}';
  v_created jsonb;
  i int;
BEGIN
  FOR i IN 1..p_members LOOP
    v_users := v_users || gen_random_uuid();
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(v_users[i],'authenticated','authenticated',v_users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',v_users[1]::text,true);
  v_created := public.create_league(p_name=>p_label,p_team_name=>'Team 1',p_auction_budget=>200);
  league := (v_created->>'id')::uuid;
  FOR i IN 2..p_members LOOP
    PERFORM set_config('request.jwt.claim.sub',v_users[i]::text,true);
    PERFORM public.join_league_by_invite_code(p_invite_code=>v_created->>'invite_code',p_team_name=>'Team '||i);
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',v_users[1]::text,true);
  SELECT COALESCE((to_jsonb(row_value)->>'future_pick_years')::int,
    (SELECT NULLIF(count(DISTINCT pick.season_year),0)::int FROM public.draft_picks pick WHERE pick.league_id=league),3)
  INTO span FROM public.leagues row_value WHERE row_value.id=league;
END;
$$;

DO $$
DECLARE
  v_season int := public.current_season_year_et(now());
  v_year int;
  v_league uuid;
  v_span int;
BEGIN
  FOR v_year IN v_season-3..v_season+1 LOOP
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(v_year,1,make_date(v_year-1,10,20),make_date(v_year-1,10,26)),(v_year,2,make_date(v_year,4,6),make_date(v_year,4,12))
    ON CONFLICT DO NOTHING;
  END LOOP;

  SELECT league,span INTO v_league,v_span FROM pg_temp.new_league('Pick invariants',4);
  PERFORM pg_temp.check_picks(v_league,v_span,'create and join');

  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leagues' AND column_name='future_pick_years') THEN
    PERFORM public.update_league_settings_atomic(v_league,jsonb_build_object('future_pick_years',5));
    v_span := 5;
    PERFORM pg_temp.check_picks(v_league,v_span,'settings change');
  END IF;

  UPDATE public.leagues SET status='playoffs' WHERE id=v_league;
  PERFORM public.advance_season_atomic(v_league);
  PERFORM pg_temp.check_picks(v_league,v_span,'advance');

  SELECT league,span INTO v_league,v_span FROM pg_temp.new_league('Pick invariants skipped season',3);
  UPDATE public.league_seasons SET season_year=season_year-2 WHERE league_id=v_league;
  UPDATE public.draft_picks SET season_year=season_year+10000-2 WHERE league_id=v_league;
  UPDATE public.draft_picks SET season_year=season_year-10000 WHERE league_id=v_league;
  UPDATE public.leagues SET status='playoffs' WHERE id=v_league;
  PERFORM public.advance_season_atomic(v_league);
  PERFORM pg_temp.check_picks(v_league,v_span,'skipped-season advance');

  IF to_regprocedure('private.roll_setup_league_seasons(timestamptz)') IS NOT NULL THEN
    SELECT league,span INTO v_league,v_span FROM pg_temp.new_league('Pick invariants July',3);
    PERFORM private.roll_setup_league_seasons(make_timestamptz(v_season,7,15,12,0,0,'America/New_York'));
    PERFORM pg_temp.check_picks(v_league,v_span,'July setup rollover');
  END IF;

  IF EXISTS(SELECT 1 FROM pick_invariant_failures) THEN
    RAISE EXCEPTION 'FAIL: pick invariants (allocate picks only through private.reconcile_future_picks; convert years with private.draft_year_for_season):%',
      (SELECT string_agg(E'\n  '||label,'' ORDER BY label) FROM pick_invariant_failures);
  END IF;
  RAISE NOTICE 'PASS: every member holds three rounds for each draft year in the window after create, join, settings change, advance, skipped-season advance and July rollover';
END;
$$;
ROLLBACK;
