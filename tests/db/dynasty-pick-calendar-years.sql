BEGIN;
SET LOCAL statement_timeout='30s';
CREATE FUNCTION pg_temp.assert_pick_calendar(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END;
$$;
DO $$
DECLARE
  users uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  members uuid[]:='{}';
  league uuid;
  season uuid;
  member uuid;
  created jsonb;
  draft jsonb;
  year int;
  next_year int;
  next_season uuid;
  first_pick uuid;
  far_pick uuid;
  outside_pick uuid:=gen_random_uuid();
  historical_pick uuid:=gen_random_uuid();
  before_ids uuid[];
  reason text;
  boundary timestamptz:=make_timestamptz(2099,10,1,0,0,0,'America/New_York');
  i int;
BEGIN
  PERFORM pg_temp.assert_pick_calendar(public.current_season_year_et(boundary-interval '1 second')=2099,
    'the season end year stays unchanged before midnight ET on October 1');
  PERFORM pg_temp.assert_pick_calendar(public.current_season_year_et(boundary)=2100,
    'the season end year advances at midnight ET on October 1');
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
  VALUES(2099,1,'2099-06-24','2099-06-30')
  ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=EXCLUDED.week_start,week_end=EXCLUDED.week_end;
  PERFORM pg_temp.assert_pick_calendar(private.setup_season_year_et(make_timestamptz(2099,6,30,12,0,0,'America/New_York'))=2099,
    'setup retains the season through its final ET calendar date');
  PERFORM pg_temp.assert_pick_calendar(private.setup_season_year_et(make_timestamptz(2099,7,1,0,0,0,'America/New_York'))=2100,
    'summer setup advances the league season without redefining the draft calendar');

  FOR i IN 1..4 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
  created:=public.create_league('Draft calendar regression','Team 1',200);
  league:=(created->>'id')::uuid;
  SELECT id,season_year INTO season,year FROM public.league_seasons WHERE league_id=league AND is_current;
  SELECT id INTO member FROM public.league_members WHERE league_id=league AND user_id=users[1];
  members:=array_append(members,member);
  PERFORM pg_temp.assert_pick_calendar((SELECT count(*)=9 AND min(season_year)=year AND max(season_year)=year+2
    AND count(DISTINCT season_year)=3 FROM public.draft_picks WHERE league_id=league),
    'creation seeds the next three draft calendar years beginning with the season end year');
  FOR i IN 2..4 LOOP
    PERFORM set_config('request.jwt.claim.sub',users[i]::text,true);
    PERFORM public.join_league_by_invite_code(created->>'invite_code','Team '||i);
    SELECT id INTO member FROM public.league_members WHERE league_id=league AND user_id=users[i];
    members:=array_append(members,member);
  END LOOP;
  PERFORM pg_temp.assert_pick_calendar((SELECT count(*)=36 AND count(DISTINCT current_owner_id)=4
    AND min(season_year)=year AND max(season_year)=year+2 FROM public.draft_picks WHERE league_id=league),
    'joining managers receive the same three calendar-year classes');
  PERFORM pg_temp.assert_pick_calendar(public.get_trade_estimate_inputs(users[1],members[1],jsonb_build_array(
    jsonb_build_object('fromMemberId',members[1],'toMemberId',members[2],'faabAmount',1)))->>'pickYearConvention'='calendar',
    'new trade inputs identify their draft-calendar convention during Edge-first rollout');
  SELECT array_agg(id ORDER BY id) INTO before_ids FROM public.draft_picks WHERE league_id=league;
  PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
  PERFORM public.update_league_settings_atomic(league,'{"future_pick_years":5}');
  PERFORM pg_temp.assert_pick_calendar((SELECT count(*)=60 AND min(season_year)=year AND max(season_year)=year+4
    AND count(DISTINCT season_year)=5 FROM public.draft_picks WHERE league_id=league),
    'expanding the horizon fills exactly five calendar years');
  PERFORM pg_temp.assert_pick_calendar((SELECT count(*)=36 FROM public.draft_picks WHERE id=ANY(before_ids)),
    'expanding the horizon preserves existing pick identities');
  UPDATE public.leagues SET status='offseason' WHERE id=league;
  SELECT id INTO first_pick FROM public.draft_picks
    WHERE league_id=league AND original_owner_id=members[1] AND season_year=year AND round=1;
  SELECT id INTO far_pick FROM public.draft_picks
    WHERE league_id=league AND original_owner_id=members[1] AND season_year=year+4 AND round=1;
  UPDATE public.draft_picks SET current_owner_id=members[2] WHERE id IN(first_pick,far_pick);
  PERFORM private.assert_trade_window(league,ARRAY[far_pick]);
  PERFORM pg_temp.assert_pick_calendar(true,'the fifth calendar-year pick remains tradeable');
  reason:=NULL;
  BEGIN
    PERFORM public.update_league_settings_atomic(league,'{"future_pick_years":4}');
  EXCEPTION WHEN invalid_parameter_value THEN reason:=SQLERRM;
  END;
  PERFORM pg_temp.assert_pick_calendar(reason LIKE 'Future draft years cannot be lower than 5%',
    'a traded fifth-year pick prevents shrinking the future window');
  INSERT INTO public.draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
  VALUES(outside_pick,league,year+5,1,members[1],members[1]);
  reason:=NULL;
  BEGIN
    PERFORM private.assert_trade_window(league,ARRAY[outside_pick]);
  EXCEPTION WHEN raise_exception THEN reason:=SQLERRM;
  END;
  PERFORM pg_temp.assert_pick_calendar(reason='Only the next 5 future draft years can be traded.',
    'the sixth calendar-year pick is outside the five-year trade window');
  PERFORM private.reconcile_future_picks(league);
  PERFORM pg_temp.assert_pick_calendar((SELECT count(*)=60 AND min(season_year)=year AND max(season_year)=year+4
    FROM public.draft_picks WHERE league_id=league),
    'reconciliation prunes the unreferenced sixth class without adding a shifted year');
  SELECT array_agg(id ORDER BY id) INTO before_ids FROM public.draft_picks WHERE league_id=league;
  PERFORM private.reconcile_future_picks(league);
  PERFORM pg_temp.assert_pick_calendar((SELECT array_agg(id ORDER BY id)=before_ids FROM public.draft_picks WHERE league_id=league),
    'repeated reconciliation preserves the exact pick identity set');
  PERFORM pg_temp.assert_pick_calendar((SELECT count(*)=2 FROM public.draft_picks
    WHERE id IN(first_pick,far_pick) AND original_owner_id=members[1] AND current_owner_id=members[2]),
    'reconciliation preserves traded original and current owners');

  INSERT INTO public.draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
  VALUES(historical_pick,league,year-1,1,members[1],members[1]);
  UPDATE public.leagues SET status='playoffs' WHERE id=league;
  SELECT new_season_id,new_year INTO next_season,next_year FROM public.advance_season_atomic(league);
  PERFORM pg_temp.assert_pick_calendar(next_year=year+1 AND next_season<>season,
    'season rollover advances the league season independently from draft calendar years');
  PERFORM pg_temp.assert_pick_calendar((SELECT is_used AND used_at IS NOT NULL FROM public.draft_picks WHERE id=historical_pick),
    'rollover retires only draft classes before the current summer draft');
  PERFORM pg_temp.assert_pick_calendar((SELECT count(*)=72 AND min(season_year)=next_year-1 AND max(season_year)=next_year+4
    AND count(DISTINCT season_year)=6 FROM public.draft_picks WHERE league_id=league AND NOT is_used),
    'rollover keeps the current summer draft plus exactly five future calendar years');
  PERFORM pg_temp.assert_pick_calendar((SELECT count(*)=2 FROM public.draft_picks
    WHERE id IN(first_pick,far_pick) AND original_owner_id=members[1] AND current_owner_id=members[2] AND NOT is_used),
    'rollover preserves traded pick identities and ownership');
  PERFORM private.assert_trade_window(league,ARRAY[first_pick]);
  PERFORM pg_temp.assert_pick_calendar(true,'the current summer draft class remains inside the offseason trade window');
  draft:=public.start_rookie_draft_atomic(league,3,false);
  PERFORM pg_temp.assert_pick_calendar((SELECT count(*)=12 FROM public.snake_draft_picks WHERE draft_id=(draft->>'id')::uuid),
    'the rookie draft allocates all current summer slots');
  PERFORM pg_temp.assert_pick_calendar((SELECT bool_and(pick.season_year=next_year-1)
    FROM public.snake_draft_picks slot JOIN public.draft_picks pick ON pick.id=slot.draft_pick_id
    WHERE slot.draft_id=(draft->>'id')::uuid),
    'every rookie slot links to the draft calendar year rather than the new season end year');
  PERFORM pg_temp.assert_pick_calendar((SELECT member_id=members[2] FROM public.snake_draft_picks
    WHERE draft_id=(draft->>'id')::uuid AND draft_pick_id=first_pick),
    'the traded current-summer slot belongs to its current owner');
  PERFORM pg_temp.assert_pick_calendar(public.reseed_rookie_draft_picks_atomic((draft->>'id')::uuid,3)=12,
    'reseeding resolves all slots from the same current summer draft class');
  PERFORM pg_temp.assert_pick_calendar((SELECT member_id=members[2] FROM public.snake_draft_picks
    WHERE draft_id=(draft->>'id')::uuid AND draft_pick_id=first_pick),
    'reseeding preserves the traded slot owner');
END;
$$;
ROLLBACK;
