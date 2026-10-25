BEGIN;
SET LOCAL statement_timeout = '45s';
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE taxi_contract_ids(name text PRIMARY KEY, id uuid NOT NULL DEFAULT gen_random_uuid());
CREATE TEMP TABLE taxi_contract_checks(name text PRIMARY KEY);
CREATE FUNCTION pg_temp.tc_id(p_name text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM taxi_contract_ids WHERE name=p_name
$$;
CREATE FUNCTION pg_temp.tc_check(p_ok boolean,p_name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',p_name; END IF;
  INSERT INTO taxi_contract_checks VALUES(p_name);
END;
$$;
CREATE FUNCTION pg_temp.tc_fails(p_sql text,p_code text,p_message text,p_name text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_code text; v_message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE,v_message=MESSAGE_TEXT;
  END;
  PERFORM pg_temp.tc_check(v_code=p_code AND v_message ~* p_message,
    p_name||coalesce(' ['||v_code||': '||v_message||']',' [unexpected success]'));
END;
$$;
CREATE FUNCTION pg_temp.tc_world(p_name text,p_full boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO taxi_contract_ids(name) SELECT p_name||'-'||suffix FROM unnest(ARRAY['league','season','member','active','target']) suffix;
  INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots,weekly_add_limit,waiver_mode)
    VALUES(pg_temp.tc_id(p_name||'-league'),'Taxi contract',pg_temp.tc_id(p_name||'-league')::text,
      pg_temp.tc_id('user'),'active',1,1,4,NULL,'rolling');
  INSERT INTO league_seasons(id,league_id,season_year,is_current)
    VALUES(pg_temp.tc_id(p_name||'-season'),pg_temp.tc_id(p_name||'-league'),public.current_season_year_et(now()),true);
  INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(pg_temp.tc_id(p_name||'-member'),pg_temp.tc_id(p_name||'-league'),pg_temp.tc_id('user'),'commissioner','Taxi team');
  INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority)
    VALUES(pg_temp.tc_id(p_name||'-league'),pg_temp.tc_id(p_name||'-season'),pg_temp.tc_id(p_name||'-member'),1)
    ON CONFLICT DO NOTHING;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games)
    VALUES(pg_temp.tc_id(p_name||'-active'),p_name,'Active','PG',ARRAY['PG'],2,500),
      (pg_temp.tc_id(p_name||'-target'),p_name,'Target','PG',ARRAY['PG'],1,64);
  IF p_full THEN
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(pg_temp.tc_id(p_name||'-league'),pg_temp.tc_id(p_name||'-season'),pg_temp.tc_id(p_name||'-member'),pg_temp.tc_id(p_name||'-active'),'draft');
  END IF;
END;
$$;

INSERT INTO taxi_contract_ids(name) VALUES('user'),('rookie'),('unknown'),('veteran'),('ir');
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
  VALUES(pg_temp.tc_id('user'),'authenticated','authenticated',pg_temp.tc_id('user')||'@example.test','{}','{}');
INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,injury_status)
  VALUES(pg_temp.tc_id('rookie'),'Unknown','Rookie','PG',ARRAY['PG'],0,NULL,NULL),
    (pg_temp.tc_id('unknown'),'Unknown','Veteran','PG',ARRAY['PG'],1,NULL,NULL),
    (pg_temp.tc_id('veteran'),'At','Threshold','PG',ARRAY['PG'],1,65,NULL),
    (pg_temp.tc_id('ir'),'Recovering','Player','PG',ARRAY['PG'],2,100,'Out');
SELECT pg_temp.tc_world('direct',true);
SELECT set_config('request.jwt.claim.sub',pg_temp.tc_id('user')::text,true);
SELECT pg_temp.tc_check((SELECT taxi_rule='rookies_or_64_games' FROM leagues WHERE id=pg_temp.tc_id('direct-league')),'one taxi rule');
SELECT pg_temp.tc_check(private.taxi_player_eligible(pg_temp.tc_id('direct-league'),pg_temp.tc_id('rookie')),'rookie with unknown games qualifies');
SELECT pg_temp.tc_check(NOT private.taxi_player_eligible(pg_temp.tc_id('direct-league'),pg_temp.tc_id('unknown')),'unknown veteran does not qualify');
SELECT pg_temp.tc_check(NOT private.taxi_player_eligible(pg_temp.tc_id('direct-league'),pg_temp.tc_id('veteran')),'65 games does not qualify');
SELECT pg_temp.tc_check(private.taxi_player_eligible(pg_temp.tc_id('direct-league'),pg_temp.tc_id('direct-target')),'64 games qualifies');
SELECT public.add_free_agent_atomic(p_member_id=>pg_temp.tc_id('direct-member'),p_league_id=>pg_temp.tc_id('direct-league'),
  p_player_id=>pg_temp.tc_id('direct-target'),p_to_ir=>false,p_to_taxi=>true);
SELECT pg_temp.tc_check((SELECT is_on_taxi AND NOT is_on_ir FROM roster_players WHERE league_id=pg_temp.tc_id('direct-league')
  AND player_id=pg_temp.tc_id('direct-target')),'full active roster adds straight to taxi');
SELECT pg_temp.tc_fails(format('SELECT public.add_free_agent_atomic(%L,%L,%L,true,true)',pg_temp.tc_id('direct-member'),
  pg_temp.tc_id('direct-league'),pg_temp.tc_id('ir')),'P0001','Choose IR or taxi, not both[.]','IR and taxi are exclusive');
SELECT pg_temp.tc_fails(format('SELECT public.add_free_agent_atomic(%L,%L,%L,false,true)',pg_temp.tc_id('direct-member'),
  pg_temp.tc_id('direct-league'),pg_temp.tc_id('veteran')),'P0001','taxi|eligible|65','ineligible taxi add fails');
SELECT pg_temp.tc_fails(format('SELECT public.add_free_agent_atomic(%L,%L,%L,false,true)',pg_temp.tc_id('direct-member'),
  pg_temp.tc_id('direct-league'),pg_temp.tc_id('unknown')),'P0001','unknown|known','unknown games have a clear error');
UPDATE players SET career_regular_season_games=65 WHERE id=pg_temp.tc_id('direct-target');
SELECT pg_temp.tc_fails(format('SELECT public.add_free_agent_atomic(p_member_id=>%L,p_league_id=>%L,p_player_id=>%L)',
  pg_temp.tc_id('direct-member'),pg_temp.tc_id('direct-league'),pg_temp.tc_id('unknown')),'PA009','direct Target','old add call sees named taxi gate');
UPDATE players SET career_regular_season_games=64 WHERE id=pg_temp.tc_id('direct-target');
SELECT public.add_free_agent_atomic(pg_temp.tc_id('direct-member'),pg_temp.tc_id('direct-league'),pg_temp.tc_id('ir'),true);
UPDATE players SET injury_status=NULL WHERE id=pg_temp.tc_id('ir');
SELECT pg_temp.tc_fails(format('SELECT public.add_free_agent_atomic(p_member_id=>%L,p_league_id=>%L,p_player_id=>%L)',
  pg_temp.tc_id('direct-member'),pg_temp.tc_id('direct-league'),pg_temp.tc_id('unknown')),'PA005','Recovering Player','old IR error code remains');
UPDATE players SET injury_status='Out' WHERE id=pg_temp.tc_id('ir');
SELECT pg_temp.tc_check(private.current_add_week_number(pg_temp.tc_id('direct-league'),pg_temp.tc_id('direct-season'))>0,'simulator add week call');

DO $$
DECLARE v_name text; v_claim uuid; v_drop uuid;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['taxi','eligibility','slots','exit','drop','no-room','edit','illegal'] LOOP
    PERFORM pg_temp.tc_world(v_name,v_name IN ('taxi','drop','no-room'));
    INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at)
      VALUES(pg_temp.tc_id(v_name||'-league'),pg_temp.tc_id(v_name||'-season'),pg_temp.tc_id(v_name||'-target'),now()-interval '1 hour',now()+interval '47 hours');
    v_drop:=CASE WHEN v_name='drop' THEN pg_temp.tc_id(v_name||'-active') ELSE NULL END;
    v_claim:=public.create_waiver_claim_atomic(p_league_id=>pg_temp.tc_id(v_name||'-league'),p_member_id=>pg_temp.tc_id(v_name||'-member'),
      p_player_id=>pg_temp.tc_id(v_name||'-target'),p_drop_player_id=>v_drop,p_user_id=>pg_temp.tc_id('user'),p_bid_amount=>0,p_to_taxi=>true);
    INSERT INTO taxi_contract_ids(name,id) VALUES(v_name||'-claim',v_claim);
    PERFORM pg_temp.tc_check((SELECT to_taxi FROM waiver_claims WHERE id=v_claim),v_name||' claim stores taxi');
    IF v_name='edit' THEN
      PERFORM public.edit_waiver_claim_atomic(p_claim_id=>v_claim,p_member_id=>pg_temp.tc_id(v_name||'-member'),p_user_id=>pg_temp.tc_id('user'),p_bid_amount=>0);
      PERFORM pg_temp.tc_check((SELECT to_taxi FROM waiver_claims WHERE id=v_claim),'omitted edit preserves taxi');
      PERFORM public.edit_waiver_claim_atomic(p_claim_id=>v_claim,p_member_id=>pg_temp.tc_id(v_name||'-member'),p_user_id=>pg_temp.tc_id('user'),p_to_taxi=>false);
      PERFORM pg_temp.tc_check((SELECT NOT to_taxi FROM waiver_claims WHERE id=v_claim),'explicit edit clears taxi');
      PERFORM public.edit_waiver_claim_atomic(p_claim_id=>v_claim,p_member_id=>pg_temp.tc_id(v_name||'-member'),p_user_id=>pg_temp.tc_id('user'),p_to_taxi=>true);
    END IF;
    IF v_name='eligibility' THEN
      UPDATE players SET career_regular_season_games=65 WHERE id=pg_temp.tc_id(v_name||'-target');
    ELSIF v_name IN ('slots','drop','no-room') THEN
      UPDATE leagues SET taxi_slots=0 WHERE id=pg_temp.tc_id(v_name||'-league');
    ELSIF v_name='exit' THEN
      INSERT INTO league_member_taxi_exits(league_id,member_id,player_id)
        VALUES(pg_temp.tc_id(v_name||'-league'),pg_temp.tc_id(v_name||'-member'),pg_temp.tc_id(v_name||'-target'));
    ELSIF v_name='illegal' THEN
      UPDATE players SET career_regular_season_games=64 WHERE id=pg_temp.tc_id(v_name||'-active');
      PERFORM public.add_free_agent_atomic(p_member_id=>pg_temp.tc_id(v_name||'-member'),p_league_id=>pg_temp.tc_id(v_name||'-league'),
        p_player_id=>pg_temp.tc_id(v_name||'-active'),p_to_ir=>false,p_to_taxi=>true);
      UPDATE players SET career_regular_season_games=65 WHERE id=pg_temp.tc_id(v_name||'-active');
    END IF;
  END LOOP;
END;
$$;
SELECT pg_temp.tc_fails(format('SELECT public.edit_waiver_claim_atomic(p_claim_id=>%L,p_member_id=>%L,p_user_id=>%L,p_to_taxi=>true)',
  pg_temp.tc_id('illegal-claim'),pg_temp.tc_id('illegal-member'),pg_temp.tc_id('user')),'PA009','illegal Active','illegal roster blocks claim edits');
INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at)
  VALUES(pg_temp.tc_id('illegal-league'),pg_temp.tc_id('illegal-season'),pg_temp.tc_id('unknown'),now(),now()+interval '48 hours');
SELECT pg_temp.tc_fails(format('SELECT public.create_waiver_claim_atomic(p_league_id=>%L,p_member_id=>%L,p_player_id=>%L,p_user_id=>%L,p_to_taxi=>true)',
  pg_temp.tc_id('illegal-league'),pg_temp.tc_id('illegal-member'),pg_temp.tc_id('unknown'),pg_temp.tc_id('user')),'PA009','illegal Active','illegal roster blocks new claims');
UPDATE waiver_wire_log SET clears_at=now()-interval '1 minute'
  WHERE league_id IN(SELECT id FROM taxi_contract_ids WHERE name LIKE '%-league');
UPDATE waiver_claims SET process_date=current_date-1
  WHERE league_id IN(SELECT id FROM taxi_contract_ids WHERE name LIKE '%-league');
SELECT * FROM public.process_due_waiver_claims_atomic(current_date,100);
DO $$
DECLARE v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['taxi','edit'] LOOP
    PERFORM pg_temp.tc_check((SELECT status='succeeded' FROM waiver_claims WHERE id=pg_temp.tc_id(v_name||'-claim')),v_name||' claim succeeds');
    PERFORM pg_temp.tc_check((SELECT is_on_taxi AND NOT is_on_ir FROM roster_players WHERE league_id=pg_temp.tc_id(v_name||'-league')
      AND player_id=pg_temp.tc_id(v_name||'-target')),v_name||' claim lands in taxi');
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY['eligibility','slots','exit','drop'] LOOP
    PERFORM pg_temp.tc_check((SELECT status='succeeded' FROM waiver_claims WHERE id=pg_temp.tc_id(v_name||'-claim')),v_name||' fallback succeeds');
    PERFORM pg_temp.tc_check((SELECT NOT is_on_taxi AND NOT is_on_ir FROM roster_players WHERE league_id=pg_temp.tc_id(v_name||'-league')
      AND player_id=pg_temp.tc_id(v_name||'-target')),v_name||' fallback lands active');
  END LOOP;
  PERFORM pg_temp.tc_check(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=pg_temp.tc_id('drop-league')
    AND player_id=pg_temp.tc_id('drop-active')),'fallback applies its planned drop');
  PERFORM pg_temp.tc_check((SELECT status='failed_roster' AND length(failure_reason)>0 FROM waiver_claims
    WHERE id=pg_temp.tc_id('no-room-claim')),'full active fallback fails with a reason');
  PERFORM pg_temp.tc_check((SELECT status='failed_roster' AND failure_reason ILIKE '%illegal Active%' FROM waiver_claims
    WHERE id=pg_temp.tc_id('illegal-claim')),'illegal roster refuses pending processing');
END;
$$;
SELECT pg_temp.tc_world('started',true);
UPDATE players SET nba_team='ZTX' WHERE id=pg_temp.tc_id('started-target');
INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,started_at,home_team,away_team,status)
  VALUES(gen_random_uuid(),'002-taxi-'||gen_random_uuid(),public.current_season_year_et(now()),1,
    (now() AT TIME ZONE 'America/New_York')::date,now()-interval '1 minute',now()-interval '1 minute','ZTX','ZTY','InProgress');
SELECT public.add_free_agent_atomic(p_member_id=>pg_temp.tc_id('started-member'),p_league_id=>pg_temp.tc_id('started-league'),
  p_player_id=>pg_temp.tc_id('started-target'),p_to_ir=>false,p_to_taxi=>true);
SELECT pg_temp.tc_check((SELECT is_on_taxi FROM roster_players WHERE league_id=pg_temp.tc_id('started-league')
  AND player_id=pg_temp.tc_id('started-target')),'started game allows straight taxi add');
SELECT count(*)||' taxi acquisition checks passed' FROM taxi_contract_checks;
ROLLBACK;
