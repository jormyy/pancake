BEGIN;
UPDATE public.lineup_optimizer_settings SET enabled=false;
CREATE TEMP TABLE tipoff_requests(body jsonb);
CREATE OR REPLACE FUNCTION public.invoke_edge_function(function_name text, body jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tipoff_requests VALUES(body);
END;
$$;
DELETE FROM private.work_items;
CREATE FUNCTION pg_temp.pre_dispatch() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_item private.work_items%ROWTYPE; v_status text; v_lease timestamptz;
BEGIN
  FOR v_item IN SELECT * FROM private.work_items WHERE kind='pre-tipoff' AND status='running' LOOP
    SELECT status,lease_until INTO v_status,v_lease FROM public.lineup_tipoff_dispatches WHERE tipoff_at=(v_item.payload->>'tipoffAt')::timestamptz;
    IF v_status='succeeded' THEN PERFORM private.work_finish(v_item.id,v_item.lease_token);
    ELSIF v_status='failed' THEN
      PERFORM private.work_finish(v_item.id,v_item.lease_token,'Synthetic worker failure');
      UPDATE private.work_items SET due_at=now() WHERE id=v_item.id AND status='failed';
    ELSIF v_lease<=now() THEN
      UPDATE private.work_items SET lease_until=now()-interval '1 second' WHERE id=v_item.id;
      PERFORM private.work_claim(0);
      UPDATE private.work_items SET due_at=now() WHERE id=v_item.id AND status='failed';
    END IF;
  END LOOP;
  PERFORM private.enqueue_pre_tipoff_optimizer();
  FOR v_item IN SELECT * FROM private.work_claim() LOOP PERFORM private.work_execute(v_item.id,v_item.lease_token); END LOOP;
END;
$$;
DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_pg uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_bench uuid := gen_random_uuid();
  v_fallback uuid := gen_random_uuid();
  v_game uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_date date := (now() AT TIME ZONE 'America/New_York')::date;
  v_tipoff timestamptz := now() + interval '90 seconds';
  v_token uuid;
  v_old_token uuid;
  v_context jsonb;
  v_assignments jsonb;
  v_id uuid;
  v_set_at timestamptz;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(v_user,v_user::text||'@example.test',jsonb_build_object('username',v_user::text));
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,auction_budget)
  VALUES(v_league,'Tipoff tests',v_league::text,v_user,'active',12,200);
  INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
  VALUES(v_member,v_league,v_user,'commissioner','Tipoff');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(v_season,v_league,2199,true);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(2199,1,v_date,v_date+6);
  INSERT INTO public.players(id,first_name,last_name,nba_team,position,eligible_positions)
  VALUES(v_pg,'Tipoff','Guard','TP1','PG',ARRAY['PG']), (v_c,'Tipoff','Center','TP3','C',ARRAY['C']),
        (v_bench,'Tipoff','Bench','TP1','PG',ARRAY['PG']),
        (v_fallback,'Tipoff','Fallback','TP5','C',ARRAY['C']);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(v_league,v_season,v_member,v_pg,'draft'),(v_league,v_season,v_member,v_c,'draft'),
        (v_league,v_season,v_member,v_bench,'draft'),(v_league,v_season,v_member,v_fallback,'draft');
  DELETE FROM public.lineup_slot_templates WHERE league_id=v_league;
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(v_league,'PG',1),(v_league,'UTIL',1);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time,started_at)
  VALUES(v_game,'0029912301',2199,1,v_date,'TP1','TP2','Scheduled',v_tipoff,v_tipoff),
        (v_other,'0029912302',2199,1,v_date,'TP3','TP4','Scheduled',v_tipoff,v_tipoff);
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
  VALUES('0029912303',2199,1,v_date,'TP5','TP6','Scheduled',now()+interval '10 minutes');
  IF NOT EXISTS(SELECT 1 FROM public.lineup_optimizer_settings WHERE member_id=v_member AND enabled)
     THEN RAISE EXCEPTION 'New team is not enabled by default'; END IF;
  DELETE FROM public.lineup_optimizer_settings WHERE member_id=v_member;
  PERFORM pg_temp.pre_dispatch();
  IF EXISTS(SELECT 1 FROM public.lineup_optimizer_settings WHERE league_id=v_league)
     OR EXISTS(SELECT 1 FROM tipoff_requests) THEN RAISE EXCEPTION 'Missing preference silently enrolls'; END IF;
  INSERT INTO public.lineup_optimizer_settings(league_id,league_season_id,member_id,enabled)
  VALUES(v_league,v_season,v_member,false);
  PERFORM pg_temp.pre_dispatch();
  IF EXISTS(SELECT 1 FROM tipoff_requests) THEN RAISE EXCEPTION 'Disabled team dispatches'; END IF;
  UPDATE public.lineup_optimizer_settings SET enabled=true WHERE member_id=v_member;
  UPDATE public.nba_games SET game_time=NULL WHERE id IN (v_game,v_other);
  PERFORM pg_temp.pre_dispatch();
  IF EXISTS(SELECT 1 FROM tipoff_requests) THEN RAISE EXCEPTION 'TBD tipoff opens a dispatch window'; END IF;
  v_context:=public.get_pre_tipoff_lineup_context(v_league,v_season,v_member);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_context->'players') p WHERE (p->>'playerId')::uuid=v_pg AND (p->>'hasGame')::boolean AND NOT (p->>'locked')::boolean) THEN RAISE EXCEPTION 'TBD game changes existing game-day eligibility'; END IF;
  UPDATE public.nba_games SET game_time=v_tipoff WHERE id IN (v_game,v_other);
  PERFORM pg_temp.pre_dispatch();
  PERFORM pg_temp.pre_dispatch();
  IF NOT EXISTS(SELECT 1 FROM tipoff_requests) THEN RAISE EXCEPTION 'Scheduled future started_at prevents pre-tipoff dispatch'; END IF;
  IF (SELECT count(*) FROM tipoff_requests)<>1 THEN RAISE EXCEPTION 'Shared tipoff duplicates dispatch'; END IF;
  SELECT token INTO v_token FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_tipoff;
  IF public.claim_lineup_tipoff_dispatch(v_tipoff,v_token) IS DISTINCT FROM v_date
     OR public.claim_lineup_tipoff_dispatch(v_tipoff,v_token) IS NOT NULL THEN RAISE EXCEPTION 'Concurrent claim succeeds'; END IF;
  IF (SELECT count(*) FROM public.get_pending_tipoff_members(v_tipoff,v_token))<>1 THEN RAISE EXCEPTION 'Pending work misses enabled team'; END IF;
  IF EXISTS(SELECT 1 FROM public.get_pending_tipoff_members(v_tipoff,v_token,ARRAY[v_member])) THEN RAISE EXCEPTION 'Failed team exclusion is ignored'; END IF;
  BEGIN
    PERFORM public.get_pending_tipoff_members(v_tipoff,v_token,ARRAY[]::uuid[],0);
    RAISE EXCEPTION 'Invalid batch size accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  IF public.renew_lineup_tipoff_dispatch(v_tipoff,gen_random_uuid()) THEN RAISE EXCEPTION 'Wrong token renews lease'; END IF;
  UPDATE public.lineup_tipoff_dispatches SET lease_until=now()+interval '5 seconds' WHERE tipoff_at=v_tipoff;
  IF NOT public.renew_lineup_tipoff_dispatch(v_tipoff,v_token) THEN RAISE EXCEPTION 'Active holder cannot renew during reads'; END IF;
  UPDATE public.lineup_tipoff_dispatches SET lease_until=now()+interval '5 seconds' WHERE tipoff_at=v_tipoff;
  v_assignments:=jsonb_build_array(jsonb_build_object('player_id',v_pg,'slot_type','PG','week_number',1,'is_auto_set',true));
  IF NOT public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,
    v_assignments||jsonb_build_array(jsonb_build_object('player_id',v_c,'slot_type','UTIL','week_number',1,'is_auto_set',true))) THEN RAISE EXCEPTION 'First apply fails'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_tipoff AND lease_until>now()+interval '30 seconds') THEN RAISE EXCEPTION 'Active worker lease is not renewed'; END IF;
  IF EXISTS(SELECT 1 FROM public.get_pending_tipoff_members(v_tipoff,v_token)) THEN RAISE EXCEPTION 'Completed team repeats expensive reads'; END IF;
  SELECT id,set_at INTO v_id,v_set_at FROM public.weekly_lineups WHERE member_id=v_member AND player_id=v_pg;
  IF public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,'[]')
     OR NOT EXISTS(SELECT 1 FROM public.weekly_lineups WHERE id=v_id AND set_at=v_set_at) THEN RAISE EXCEPTION 'Retry flaps lineup'; END IF;
  UPDATE public.lineup_tipoff_dispatches SET status='running',lease_until=now()-interval '1 second' WHERE tipoff_at=v_tipoff;
  IF public.renew_lineup_tipoff_dispatch(v_tipoff,v_token) THEN RAISE EXCEPTION 'Expired lease revived'; END IF;
  BEGIN
    PERFORM public.get_pending_tipoff_members(v_tipoff,v_token);
    RAISE EXCEPTION 'Expired holder reads work';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  BEGIN
    PERFORM public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,'[]');
    RAISE EXCEPTION 'Expired holder writes before replacement';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  v_old_token:=v_token;
  PERFORM pg_temp.pre_dispatch();
  SELECT token INTO v_token FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_tipoff;
  IF v_old_token=v_token THEN RAISE EXCEPTION 'Stale claim never retries'; END IF;
  BEGIN
    PERFORM public.apply_pre_tipoff_lineup(v_tipoff,v_old_token,v_league,v_season,v_member,'[]');
    RAISE EXCEPTION 'Old worker changes lineup';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  PERFORM public.claim_lineup_tipoff_dispatch(v_tipoff,v_token);
  IF public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,'[]')
     OR NOT EXISTS(SELECT 1 FROM public.weekly_lineups WHERE id=v_id AND set_at=v_set_at) THEN RAISE EXCEPTION 'Recovered claim repeats completed team'; END IF;
  PERFORM public.finish_lineup_tipoff_dispatch(v_tipoff,v_token,'injected failure');
  PERFORM pg_temp.pre_dispatch();
  SELECT token INTO v_token FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_tipoff;
  PERFORM public.claim_lineup_tipoff_dispatch(v_tipoff,v_token);
  PERFORM public.finish_lineup_tipoff_dispatch(v_tipoff,v_token);
  PERFORM pg_temp.pre_dispatch();
  IF (SELECT attempts FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_tipoff)<>3 THEN RAISE EXCEPTION 'Completed dispatch repeats'; END IF;

  UPDATE public.nba_games SET status='InProgress',started_at=now()-interval '1 second' WHERE id=v_game;
  UPDATE public.players SET injury_status='Out' WHERE id=v_pg;
  UPDATE public.nba_games SET game_status_text='PPD' WHERE id=v_game;
  v_tipoff:=now()+interval '100 seconds';
  UPDATE public.nba_games SET game_time=v_tipoff WHERE id=v_other;
  PERFORM pg_temp.pre_dispatch();
  SELECT token INTO v_token FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_tipoff;
  PERFORM public.claim_lineup_tipoff_dispatch(v_tipoff,v_token);
  v_context:=public.get_pre_tipoff_lineup_context(v_league,v_season,v_member);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_context->'stored') e WHERE (e->>'player_id')::uuid=v_pg AND (e->>'locked')::boolean) THEN RAISE EXCEPTION 'Locked Out is not locked'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_context->'players') p WHERE (p->>'playerId')::uuid=v_bench AND (p->>'locked')::boolean)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_context->'stored') e WHERE (e->>'player_id')::uuid=v_bench) THEN RAISE EXCEPTION 'Started player without a lineup row has incorrect lock context'; END IF;
  BEGIN
    PERFORM public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,
      v_assignments||jsonb_build_array(jsonb_build_object('player_id',v_bench,'slot_type','UTIL','week_number',1,'is_auto_set',true)));
    RAISE EXCEPTION 'Started bench player enters lineup' USING ERRCODE='XX000';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Lineup changes are locked after %' THEN RAISE; END IF;
  END;
  v_assignments:=v_assignments||jsonb_build_array(jsonb_build_object('player_id',v_c,'slot_type','UTIL','week_number',1,'is_auto_set',true));
  UPDATE public.players SET injury_status='Out' WHERE id=v_c;
  BEGIN
    PERFORM public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,v_assignments);
    RAISE EXCEPTION 'New Out starter applies';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  UPDATE public.players SET injury_status=NULL WHERE id=v_c;
  UPDATE public.nba_games SET game_status_text='PPD' WHERE id=v_other;
  BEGIN
    PERFORM public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,v_assignments);
    RAISE EXCEPTION 'Late postponement newly starts a player';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  UPDATE public.nba_games SET game_status_text=NULL WHERE id=v_other;
  UPDATE public.lineup_optimizer_settings SET enabled=false WHERE member_id=v_member;
  IF public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,v_assignments) THEN RAISE EXCEPTION 'Opt-out ignored by queued worker'; END IF;
  UPDATE public.lineup_optimizer_settings SET enabled=true WHERE member_id=v_member;
  PERFORM public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,v_assignments);
  IF NOT EXISTS(SELECT 1 FROM public.weekly_lineups WHERE id=v_id AND set_at=v_set_at AND player_id=v_pg AND slot_type='PG') THEN RAISE EXCEPTION 'Locked Out moves'; END IF;
  IF EXISTS(SELECT 1 FROM public.weekly_lineups WHERE member_id=v_member AND player_id=v_bench)
     OR NOT EXISTS(SELECT 1 FROM public.roster_players WHERE member_id=v_member AND player_id=v_bench) THEN RAISE EXCEPTION 'Started bench player is changed or dropped'; END IF;
  UPDATE public.nba_games SET status='Postponed',game_time=now()+interval '110 seconds' WHERE id=v_other;
  v_context:=public.get_pre_tipoff_lineup_context(v_league,v_season,v_member);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_context->'players') p WHERE (p->>'playerId')::uuid=v_c AND ((p->>'hasGame')::boolean OR (p->>'locked')::boolean)) THEN RAISE EXCEPTION 'Postponed player plays or locks early'; END IF;
  PERFORM pg_temp.pre_dispatch();
  IF EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=now()+interval '110 seconds') THEN RAISE EXCEPTION 'Postponed game dispatches'; END IF;
  UPDATE public.nba_games SET status='Scheduled',game_status_text='PPD' WHERE id=v_other;
  v_context:=public.get_pre_tipoff_lineup_context(v_league,v_season,v_member);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_context->'players') p WHERE (p->>'playerId')::uuid=v_c AND (p->>'hasGame')::boolean) THEN RAISE EXCEPTION 'Scheduled PPD game supplies starters'; END IF;
  PERFORM pg_temp.pre_dispatch();
  IF EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=now()+interval '110 seconds') THEN RAISE EXCEPTION 'Scheduled PPD game dispatches'; END IF;
  IF private.lineup_game_available('Scheduled','Postponed until tomorrow')
     OR private.lineup_game_available('Scheduled','Canceled')
     OR private.lineup_game_available('Scheduled','Suspended')
     OR NOT private.lineup_game_available('Scheduled','7:30 pm ET') THEN RAISE EXCEPTION 'Provider status text is ignored or misread'; END IF;
  UPDATE public.nba_games SET status='Scheduled',game_status_text=NULL,game_time=now()+interval '30 seconds' WHERE id=v_other;
  v_tipoff:=now()-interval '10 seconds';
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,status,attempts,input_revision,input_fingerprint)
  VALUES(v_tipoff,v_date,'succeeded',1,1,private.pre_tipoff_input_fingerprint(v_date));
  PERFORM pg_temp.pre_dispatch();
  IF (SELECT attempts FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_tipoff)<>1 THEN RAISE EXCEPTION 'Unchanged inputs repeat a completed window'; END IF;
  UPDATE public.players SET injury_status='Out' WHERE id=v_c;
  PERFORM pg_temp.pre_dispatch();
  SELECT token INTO v_token FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_tipoff;
  IF (SELECT input_revision FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_tipoff)<>2
     OR public.claim_lineup_tipoff_dispatch(v_tipoff,v_token) IS DISTINCT FROM v_date THEN RAISE EXCEPTION 'Late news at tipoff never refreshes unlocked slots'; END IF;
  v_assignments:=jsonb_build_array(jsonb_build_object('player_id',v_pg,'slot_type','PG','week_number',1,'is_auto_set',true));
  PERFORM public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,
    v_assignments||jsonb_build_array(jsonb_build_object('player_id',v_fallback,'slot_type','UTIL','week_number',1,'is_auto_set',true)));
  IF EXISTS(SELECT 1 FROM public.weekly_lineups WHERE member_id=v_member AND player_id=v_c)
     OR NOT EXISTS(SELECT 1 FROM public.weekly_lineups WHERE id=v_id AND set_at=v_set_at) THEN RAISE EXCEPTION 'Late news keeps unlocked Out or moves locked Out'; END IF;
  IF public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,'[]') THEN RAISE EXCEPTION 'News revision retry repeats its write'; END IF;
  PERFORM public.finish_lineup_tipoff_dispatch(v_tipoff,v_token);
  UPDATE public.players SET injury_status=NULL WHERE id=v_c;
  PERFORM public.auto_set_lineup_service_atomic(v_member,v_league,v_season,v_date,
    v_assignments||jsonb_build_array(jsonb_build_object('player_id',v_c,'slot_type','UTIL','week_number',1,'is_auto_set',true)));
  v_old_token:=v_token;
  UPDATE public.nba_games SET game_status_text='PPD' WHERE id=v_other;
  PERFORM pg_temp.pre_dispatch();
  SELECT token INTO v_token FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_tipoff;
  IF public.claim_lineup_tipoff_dispatch(v_tipoff,v_token) IS DISTINCT FROM v_date THEN RAISE EXCEPTION 'Post-dispatch postponement never claims fresh work'; END IF;
  BEGIN
    PERFORM public.apply_pre_tipoff_lineup(v_tipoff,v_old_token,v_league,v_season,v_member,v_assignments);
    RAISE EXCEPTION 'An older input revision still applies';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  PERFORM public.apply_pre_tipoff_lineup(v_tipoff,v_token,v_league,v_season,v_member,
    v_assignments||jsonb_build_array(jsonb_build_object('player_id',v_fallback,'slot_type','UTIL','week_number',1,'is_auto_set',true)));
  IF EXISTS(SELECT 1 FROM public.weekly_lineups WHERE member_id=v_member AND player_id=v_c)
     OR NOT EXISTS(SELECT 1 FROM public.weekly_lineups WHERE id=v_id AND set_at=v_set_at) THEN RAISE EXCEPTION 'Post-dispatch postponement leaves an unlocked starter or moves a lock'; END IF;
  DELETE FROM public.season_weeks WHERE season_year=2199;
  v_context:=public.get_pre_tipoff_lineup_context(v_league,v_season,v_member);
  IF v_context IS NULL OR v_context->'weekNumber'<>'null'::jsonb THEN RAISE EXCEPTION 'Missing week silently removes eligible team'; END IF;
  IF has_function_privilege('authenticated','public.apply_pre_tipoff_lineup(timestamptz,uuid,uuid,uuid,uuid,jsonb)','EXECUTE')
     OR has_table_privilege('authenticated','public.lineup_tipoff_members','SELECT') THEN RAISE EXCEPTION 'Internal dispatch is public'; END IF;
END;
$$;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I',role_name);
    BEGIN
      PERFORM public.renew_lineup_tipoff_dispatch(now(),gen_random_uuid());
      RAISE EXCEPTION 'Client renews internal tipoff lease';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN
      PERFORM public.get_pending_tipoff_members(now(),gen_random_uuid());
      RAISE EXCEPTION 'Client reads internal pending teams';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
  END LOOP;
END;
$$;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF public.renew_lineup_tipoff_dispatch(now(),gen_random_uuid()) THEN RAISE EXCEPTION 'Service invents a lease'; END IF;
  BEGIN
    PERFORM public.get_pending_tipoff_members(now(),gen_random_uuid());
    RAISE EXCEPTION 'Service bypasses holder validation';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
END;
$$;
RESET ROLE;
ROLLBACK;
