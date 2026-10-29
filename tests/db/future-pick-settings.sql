BEGIN;
SET LOCAL statement_timeout='30s';
CREATE FUNCTION pg_temp.assert_future_setting(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END;
$$;
DO $$
DECLARE
  users uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid()];
  league uuid; member uuid; other uuid; pick uuid; reason text; item jsonb; year int; before_ids uuid[]; versions text[]; season uuid; trade uuid; peer_pick uuid;
BEGIN
  FOR i IN 1..2 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
  item:=public.create_league('Future settings','Owner',200);
  league:=(item->>'id')::uuid;
  SELECT id INTO member FROM public.league_members WHERE league_id=league;
  SELECT season_year INTO year FROM public.league_seasons WHERE league_id=league AND is_current;
  SELECT array_agg(id ORDER BY id) INTO before_ids FROM public.draft_picks WHERE league_id=league;
  PERFORM public.update_league_settings_atomic(league,'{"future_pick_years":5}');
  PERFORM pg_temp.assert_future_setting((SELECT count(*)=15 AND max(season_year)=year+5 FROM public.draft_picks WHERE league_id=league),'increasing setting seeds all five years');
  PERFORM pg_temp.assert_future_setting((SELECT count(*)=9 FROM public.draft_picks WHERE id=ANY(before_ids)),'increasing preserves existing picks');
  PERFORM set_config('request.jwt.claim.sub',users[2]::text,true);
  PERFORM public.join_league_by_invite_code(item->>'invite_code','Other');
  SELECT id INTO other FROM public.league_members WHERE league_id=league AND user_id=users[2];
  BEGIN
    PERFORM public.update_league_settings_atomic(league,'{"future_pick_years":4}');
    RAISE EXCEPTION 'manager changed horizon';
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM pg_temp.assert_future_setting(true,'only commissioner changes horizon');
  END;
  PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
  FOREACH item IN ARRAY ARRAY['{"future_pick_years":0}'::jsonb,'{"future_pick_years":11}','{"future_pick_years":1.5}','{"future_pick_years":null}','{"future_pick_years":"5"}'] LOOP
    BEGIN
      PERFORM public.update_league_settings_atomic(league,item);
      RAISE EXCEPTION 'invalid horizon accepted';
    EXCEPTION WHEN invalid_parameter_value THEN
      PERFORM pg_temp.assert_future_setting(true,'invalid horizon rejected: '||item::text);
    END;
  END LOOP;
  UPDATE public.leagues SET status='offseason' WHERE id=league;
  SELECT id INTO pick FROM public.draft_picks WHERE league_id=league AND original_owner_id=member AND season_year=year+5 AND round=1;
  PERFORM private.assert_trade_window(league,ARRAY[pick]);
  PERFORM pg_temp.assert_future_setting(true,'fifth future year can be traded');
  UPDATE public.draft_picks SET current_owner_id=other WHERE id=pick;
  BEGIN
    PERFORM public.update_league_settings_atomic(league,'{"future_pick_years":4}');
    RAISE EXCEPTION 'traded pick horizon lowered';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
    PERFORM pg_temp.assert_future_setting(reason LIKE 'Future draft years cannot be lower than 5%','traded fifth-year pick blocks lowering with clear message');
  END;
  UPDATE public.draft_picks SET current_owner_id=member WHERE id=pick;
  PERFORM public.update_league_settings_atomic(league,'{"future_pick_years":1}');
  PERFORM pg_temp.assert_future_setting((SELECT count(*)=6 AND max(season_year)=year+1 FROM public.draft_picks WHERE league_id=league),'safe lowering prunes only unreferenced own picks');
  PERFORM public.update_league_settings_atomic(league,'{"future_pick_years":10}');
  PERFORM pg_temp.assert_future_setting((SELECT count(*)=60 AND max(season_year)=year+10 FROM public.draft_picks WHERE league_id=league),'maximum horizon creates ten years');
  DELETE FROM public.dynasty_pick_values;
  INSERT INTO public.dynasty_pick_values(draft_year,round,tier,trade_value,derived,fetched_at)
    SELECT year+offset_value,round_value,tier_value,round(800*power(0.8,offset_value)/round_value,2),round_value=3,now()
    FROM generate_series(0,2) offset_value CROSS JOIN generate_series(1,3) round_value CROSS JOIN unnest(ARRAY['early','mid','late']) tier_value;
  PERFORM public.update_league_settings_atomic(league,'{"future_pick_years":5}');
  PERFORM pg_temp.assert_future_setting((SELECT count(*)=45 AND max(draft_year)=year+4 FROM public.get_dynasty_pick_values(league)),'values cover all five years and three tiers and rounds');
  PERFORM pg_temp.assert_future_setting((SELECT trade_value=409.60 FROM public.get_dynasty_pick_values(league) WHERE draft_year=year+3 AND round=1 AND tier='mid'),'fourth-year value compounds last annual ratio');
  PERFORM pg_temp.assert_future_setting((SELECT trade_value=327.68 FROM public.get_dynasty_pick_values(league) WHERE draft_year=year+4 AND round=1 AND tier='mid'),'fifth-year value compounds annual decay again');
  PERFORM pg_temp.assert_future_setting((SELECT min((value->'bands'->>'mid')::numeric)>0 FROM jsonb_array_elements(public.get_pick_prediction_inputs(league)->'picks') value),'predictions receive nonzero bands for all five years');
  PERFORM pg_temp.assert_future_setting((SELECT jsonb_array_length(public.view_picks(league,member)->'picks')=30),'Picks view returns five years per team');
  SELECT id INTO pick FROM public.draft_picks WHERE league_id=league AND original_owner_id=member AND season_year=year+5 AND round=1;
  item:=public.get_trade_estimate_inputs(users[1],member,jsonb_build_array(jsonb_build_object('pickId',pick,'fromMemberId',member,'toMemberId',other)));
  PERFORM pg_temp.assert_future_setting((item->'picks'->0->'valueBands'->>'mid')::numeric=327.68,'trade estimates value the fifth-year pick with extended bands');
  SELECT id INTO season FROM public.league_seasons WHERE league_id=league AND is_current;
  SELECT id INTO peer_pick FROM public.draft_picks WHERE league_id=league AND original_owner_id=other AND season_year=year+1 AND round=1;
  trade:=public.propose_trade_atomic(league,season,member,other,'{}','{}',ARRAY[pick],ARRAY[peer_pick]);
  PERFORM pg_temp.assert_future_setting(trade IS NOT NULL,'fifth-year picks can be offered through the real trade RPC');
  BEGIN
    PERFORM public.update_league_settings_atomic(league,'{"future_pick_years":4}');
    RAISE EXCEPTION 'referenced pick horizon lowered';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
    PERFORM pg_temp.assert_future_setting(reason LIKE 'Future draft years cannot be lower than 5%','trade references block lowering even before ownership changes');
  END;
END;
$$;
ROLLBACK;
