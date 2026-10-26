BEGIN;
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('da000000-0000-4000-8000-000000000001','authenticated','authenticated','straight-ir@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots)
VALUES ('da000000-0000-4000-8000-000000000002','IR adds','straight-ir','da000000-0000-4000-8000-000000000001','active',1,1);
INSERT INTO league_members(id,league_id,user_id,role,team_name)
VALUES ('da000000-0000-4000-8000-000000000003','da000000-0000-4000-8000-000000000002','da000000-0000-4000-8000-000000000001','commissioner','IR team');
INSERT INTO league_seasons(id,league_id,season_year,is_current)
VALUES ('da000000-0000-4000-8000-000000000004','da000000-0000-4000-8000-000000000002',public.current_season_year_et(),true);
INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority)
VALUES ('da000000-0000-4000-8000-000000000002','da000000-0000-4000-8000-000000000004','da000000-0000-4000-8000-000000000003',1);
INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,injury_status)
SELECT ('da100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'IR','Player '||n,'IRX','PG',ARRAY['PG'],CASE WHEN n=1 THEN NULL ELSE 'Out' END
FROM generate_series(1,5)n;
INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
VALUES ('da000000-0000-4000-8000-000000000002','da000000-0000-4000-8000-000000000004','da000000-0000-4000-8000-000000000003','da100000-0000-4000-8000-000000000001','draft');
SELECT set_config('request.jwt.claim.sub','da000000-0000-4000-8000-000000000001',true);
CREATE FUNCTION pg_temp.expect_ir_error(p_query text,p_code text,p_message text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_query;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE=p_code AND (p_message IS NULL OR position(p_message IN SQLERRM)>0) THEN RETURN; END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'Expected % from %',p_code,p_query;
END;
$$;
CREATE FUNCTION pg_temp.test_ir_award(p_case text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_claim uuid; v_result record; v_expected_ir boolean; v_expected_fail boolean;
BEGIN
  UPDATE leagues SET roster_size=CASE WHEN p_case IN ('eligible-room','recovered-room','filled-room') THEN 2 ELSE 1 END
    WHERE id='da000000-0000-4000-8000-000000000002';
  INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at)
  VALUES ('da000000-0000-4000-8000-000000000002','da000000-0000-4000-8000-000000000004','da100000-0000-4000-8000-000000000004',now()-interval '3 days',now()-interval '1 day');
  v_claim:=create_waiver_claim_atomic('da000000-0000-4000-8000-000000000002','da000000-0000-4000-8000-000000000003','da100000-0000-4000-8000-000000000004',p_drop_player_id=>CASE WHEN p_case='eligible-drop' THEN 'da100000-0000-4000-8000-000000000001'::uuid ELSE NULL END,p_to_ir=>true);
  PERFORM edit_waiver_claim_atomic(v_claim,'da000000-0000-4000-8000-000000000003','da000000-0000-4000-8000-000000000001',p_to_ir=>false);
  IF (SELECT to_ir FROM waiver_claims WHERE id=v_claim) THEN RAISE EXCEPTION 'Claim edit does not clear IR preference'; END IF;
  PERFORM edit_waiver_claim_atomic(v_claim,'da000000-0000-4000-8000-000000000003','da000000-0000-4000-8000-000000000001',p_drop_player_id=>CASE WHEN p_case='eligible-drop' THEN 'da100000-0000-4000-8000-000000000001'::uuid ELSE NULL END,p_to_ir=>true);
  IF NOT (SELECT to_ir FROM waiver_claims WHERE id=v_claim) THEN RAISE EXCEPTION 'Claim edit loses IR preference'; END IF;
  IF p_case LIKE 'recovered-%' THEN UPDATE players SET injury_status=NULL WHERE id='da100000-0000-4000-8000-000000000004'; END IF;
  IF p_case LIKE 'filled-%' THEN
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir)
    VALUES ('da000000-0000-4000-8000-000000000002','da000000-0000-4000-8000-000000000004','da000000-0000-4000-8000-000000000003','da100000-0000-4000-8000-000000000005','draft',true);
  END IF;
  IF p_case='eligible-ir' THEN UPDATE players SET injury_status='IR' WHERE id='da100000-0000-4000-8000-000000000004'; END IF;
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
  VALUES ('da000000-0000-4000-8000-000000000005','002irtest',public.current_season_year_et(),1,(now() AT TIME ZONE 'America/New_York')::date,'IRX','IRY','InProgress',now()-interval '1 hour');
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=v_claim;
  UPDATE waiver_wire_log SET clears_at=now()-interval '3 days' WHERE player_id='da100000-0000-4000-8000-000000000004';
  SELECT * INTO v_result FROM process_next_waiver_claim_atomic(current_date+2);
  v_expected_fail:=p_case IN ('recovered-full','filled-full');
  v_expected_ir:=p_case IN ('eligible','eligible-ir','eligible-room','eligible-drop');
  IF v_result.claim_id IS DISTINCT FROM v_claim OR v_result.status IS DISTINCT FROM (CASE WHEN v_expected_fail THEN 'failed_roster'::waiver_claim_status ELSE 'succeeded'::waiver_claim_status END) THEN
    RAISE EXCEPTION 'Wrong waiver outcome for %: %',p_case,row_to_json(v_result);
  END IF;
  IF v_expected_fail THEN
    IF v_result.failure_reason IS DISTINCT FROM (CASE WHEN p_case='recovered-full' THEN 'Player is no longer IR eligible.' ELSE 'Your IR slots are full.' END)||' Your active roster is full.' THEN RAISE EXCEPTION 'Missing clear IR failure reason'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM roster_players WHERE player_id='da100000-0000-4000-8000-000000000004' AND is_on_ir=v_expected_ir AND NOT is_on_taxi) THEN
    RAISE EXCEPTION 'Wrong awarded roster destination for %',p_case;
  END IF;
  IF v_expected_ir AND NOT EXISTS(SELECT 1 FROM roster_players WHERE player_id='da100000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'IR award drops an active player'; END IF;
  IF v_expected_ir THEN
    PERFORM pg_temp.expect_ir_error(format('SELECT toggle_ir_atomic(%L,true,%L)',
      (SELECT id FROM roster_players WHERE player_id='da100000-0000-4000-8000-000000000001'),
      'da000000-0000-4000-8000-000000000001'), 'P0001', 'game has already started');
    PERFORM pg_temp.expect_ir_error(format('SELECT toggle_ir_atomic(%L,false,%L)',
      (SELECT id FROM roster_players WHERE player_id='da100000-0000-4000-8000-000000000004'),
      'da000000-0000-4000-8000-000000000001'), 'P0001', 'game has already started');
    IF (SELECT sum(add_count) FROM weekly_add_counts WHERE member_id='da000000-0000-4000-8000-000000000003')<>1
      OR (SELECT count(*) FROM roster_transactions WHERE related_claim_id=v_claim AND transaction_type='waiver_add')<>1 THEN
      RAISE EXCEPTION 'IR award loses its add count or writes duplicate transaction history';
    END IF;
  END IF;
END;
$$;
SAVEPOINT award;
SELECT pg_temp.test_ir_award('eligible');
ROLLBACK TO award;
SELECT pg_temp.test_ir_award('eligible-ir');
ROLLBACK TO award;
SELECT pg_temp.test_ir_award('eligible-room');
ROLLBACK TO award;
SELECT pg_temp.test_ir_award('eligible-drop');
ROLLBACK TO award;
SELECT pg_temp.test_ir_award('recovered-room');
ROLLBACK TO award;
SELECT pg_temp.test_ir_award('filled-room');
ROLLBACK TO award;
SELECT pg_temp.test_ir_award('recovered-full');
ROLLBACK TO award;
SELECT pg_temp.test_ir_award('filled-full');
ROLLBACK;
