\if :{?pickup_path}
\else
\set pickup_path all
\endif
BEGIN;
SELECT set_config('tests.pickup_path',:'pickup_path',true);
\ir rules-support.sql

CREATE FUNCTION pg_temp.pickup_snapshot(p_league uuid, p_processed_claim uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'roster', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM roster_players r WHERE league_id=p_league),
    'transactions', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM roster_transactions r WHERE league_id=p_league),
    'waivers', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM waiver_wire_log r WHERE league_id=p_league),
    'adds', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.member_id,r.week_number),'[]') FROM weekly_add_counts r WHERE league_id=p_league),
    'budget', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.member_id),'[]') FROM faab_balances r WHERE league_id=p_league),
    'priority', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.member_id),'[]') FROM waiver_priorities r WHERE league_id=p_league),
    'claims', (SELECT coalesce(jsonb_agg(CASE WHEN r.id=p_processed_claim THEN to_jsonb(r)-'status'-'processed_at'-'failure_reason' ELSE to_jsonb(r) END ORDER BY r.id),'[]') FROM waiver_claims r WHERE league_id=p_league),
    'lineups', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM weekly_lineups r WHERE league_id=p_league),
    'exits', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.member_id,r.player_id),'[]') FROM league_member_taxi_exits r WHERE league_id=p_league)
  );
$$;

CREATE FUNCTION pg_temp.reject_pickup_add_count()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_id::text=current_setting('tests.reject_add_member',true) AND NEW.add_count>OLD.add_count THEN
    RAISE EXCEPTION 'Pickup count rejected after roster and budget writes.'
      USING ERRCODE=coalesce(nullif(current_setting('tests.reject_add_code',true),''),'PA008');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_pickup_add_count BEFORE UPDATE ON weekly_add_counts
  FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_pickup_add_count();

CREATE FUNCTION pg_temp.active_pickup_lock_error(p_drop boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_drop uuid:=gen_random_uuid();
  v_incoming uuid:=gen_random_uuid();
  v_claim uuid;
  v_before jsonb;
  v_code text;
  v_message text;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,public.current_season_year_et());
  UPDATE leagues SET weekly_add_limit=10,waiver_mode='faab',faab_starting_budget=100 WHERE id=f.league_id;
  INSERT INTO faab_balances(league_id,league_season_id,member_id,balance)
    VALUES(f.league_id,f.season_id,f.member_ids[1],100)
    ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions)
    SELECT id,'Active','Lock','PG',ARRAY['PG'] FROM unnest(ARRAY[v_drop,v_incoming]) id;
  IF p_drop THEN
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft');
  END IF;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  v_claim:=public.create_waiver_claim_atomic(p_league_id=>f.league_id,p_member_id=>f.member_ids[1],p_player_id=>v_incoming,
    p_drop_player_id=>CASE WHEN p_drop THEN v_drop END,p_user_id=>f.user_ids[1],p_bid_amount=>7);
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=v_claim;
  PERFORM set_config('tests.reject_add_member',f.member_ids[1]::text,true);
  PERFORM set_config('tests.reject_add_code','PA004',true);
  v_before:=pg_temp.pickup_snapshot(f.league_id);
  BEGIN
    PERFORM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  EXCEPTION WHEN OTHERS THEN
    v_code:=SQLSTATE;v_message:=SQLERRM;
  END;
  PERFORM pg_temp.check_rules(v_code='PA004' AND v_message='Pickup count rejected after roster and budget writes.',
    CASE WHEN p_drop THEN 'Active-drop' ELSE 'No-drop' END||' claim propagates PA004 as on main');
  PERFORM pg_temp.check_rules(pg_temp.pickup_snapshot(f.league_id)=v_before,
    CASE WHEN p_drop THEN 'Active-drop' ELSE 'No-drop' END||' propagated PA004 preserves every row and the pending claim');
  UPDATE waiver_claims SET process_date=current_date+365000 WHERE id=v_claim;
END;
$$;
SELECT pg_temp.active_pickup_lock_error(drop_player) FROM unnest(ARRAY[true,false]) drop_player
  WHERE current_setting('tests.pickup_path') IN ('all','legacy_locks');

CREATE FUNCTION pg_temp.inactive_claim(p_slot text, p_case text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_active uuid:=gen_random_uuid();
  v_drop uuid:=gen_random_uuid();
  v_incoming uuid:=gen_random_uuid();
  v_drop_row uuid;
  v_claim uuid;
  v_before jsonb;
  v_result record;
  v_code text;
  v_to_ir boolean:=p_slot='ir';
  v_to_taxi boolean:=p_slot='taxi';
  v_reject boolean:=p_case NOT IN ('success','active_room');
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,public.current_season_year_et());
  UPDATE leagues SET roster_size=1,taxi_slots=1,ir_slots=1,weekly_add_limit=10,waiver_mode='faab',faab_starting_budget=100 WHERE id=f.league_id;
  INSERT INTO faab_balances(league_id,league_season_id,member_id,balance) VALUES(f.league_id,f.season_id,f.member_ids[1],100) ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,injury_status)
    SELECT id,'Inactive',ordinal::text,'PG',ARRAY['PG'],0,0,'Out'
      FROM unnest(ARRAY[v_active,v_drop,v_incoming]) WITH ORDINALITY p(id,ordinal);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],v_active,'draft');
  IF p_slot='taxi' THEN
    PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',v_drop);
  END IF;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir,is_on_taxi)
    VALUES(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',v_to_ir,v_to_taxi) RETURNING id INTO v_drop_row;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  IF p_case='active_room' THEN
    UPDATE leagues SET roster_size=2 WHERE id=f.league_id;
    v_to_ir:=false;v_to_taxi:=false;
  END IF;
  v_claim:=public.create_waiver_claim_atomic(p_league_id=>f.league_id,p_member_id=>f.member_ids[1],p_player_id=>v_incoming,
    p_drop_player_id=>v_drop,p_user_id=>f.user_ids[1],p_bid_amount=>7,p_to_ir=>v_to_ir,p_to_taxi=>v_to_taxi);
  PERFORM public.edit_waiver_claim_atomic(v_claim,f.member_ids[1],f.user_ids[1],v_drop,7,NULL,v_to_ir,v_to_taxi);
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=v_claim;
  IF p_case IN ('late_failure','lock_error') THEN
    PERFORM set_config('tests.reject_add_member',f.member_ids[1]::text,true);
    PERFORM set_config('tests.reject_add_code',CASE WHEN p_case='lock_error' THEN 'PA004' ELSE 'PA008' END,true);
  ELSIF p_case='ineligible' THEN
    UPDATE leagues SET roster_size=2 WHERE id=f.league_id;
    UPDATE players SET injury_status=NULL,years_exp=4,career_regular_season_games=200 WHERE id=v_incoming;
  ELSIF p_case='limit' THEN
    UPDATE leagues SET weekly_add_limit=1 WHERE id=f.league_id;
    INSERT INTO weekly_add_counts(league_id,league_season_id,member_id,week_number,add_count)
      VALUES(f.league_id,f.season_id,f.member_ids[1],private.current_add_week_number(f.league_id,f.season_id),1)
      ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO UPDATE SET add_count=1;
  ELSIF p_case='game_lock' THEN
    UPDATE players SET nba_team='IPX' WHERE id=v_drop;
    INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
      VALUES(v_drop::text,public.current_season_year_et(),1,(now() AT TIME ZONE 'America/New_York')::date,'IPX','IPY','InProgress',now()-interval '1 hour');
  ELSIF p_case='moved' THEN
    v_before:=pg_temp.pickup_snapshot(f.league_id);
    BEGIN
      UPDATE roster_players SET is_on_ir=false,is_on_taxi=false WHERE id=v_drop_row;
    EXCEPTION WHEN OTHERS THEN
      v_code:=SQLSTATE;
    END;
    PERFORM pg_temp.check_rules(v_code='PA004',p_slot||' pending claim still locks ordinary slot moves');
    PERFORM pg_temp.check_rules(pg_temp.pickup_snapshot(f.league_id)=v_before,p_slot||' locked ordinary move preserves all rows');
    SET CONSTRAINTS ALL IMMEDIATE;
    ALTER TABLE roster_players DISABLE TRIGGER a_pending_asset_roster_move;
    SET CONSTRAINTS ALL DEFERRED;
    UPDATE leagues SET roster_size=2 WHERE id=f.league_id;
    UPDATE roster_players SET is_on_ir=false,is_on_taxi=false WHERE id=v_drop_row;
    SET CONSTRAINTS ALL IMMEDIATE;
    ALTER TABLE roster_players ENABLE TRIGGER a_pending_asset_roster_move;
    SET CONSTRAINTS ALL DEFERRED;
  ELSIF p_case='capacity' THEN
    IF v_to_ir THEN UPDATE leagues SET ir_slots=0 WHERE id=f.league_id;
    ELSE UPDATE leagues SET taxi_slots=0 WHERE id=f.league_id; END IF;
  ELSIF p_case='budget' THEN
    UPDATE faab_balances SET balance=0 WHERE league_id=f.league_id AND member_id=f.member_ids[1];
  ELSIF p_case='active_full' THEN
    v_to_ir:=false;v_to_taxi:=false;
    UPDATE waiver_claims SET to_ir=false,to_taxi=false WHERE id=v_claim;
  END IF;
  v_before:=pg_temp.pickup_snapshot(f.league_id,v_claim);
  SELECT * INTO v_result FROM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  IF v_reject THEN
    PERFORM pg_temp.check_rules(v_result.claim_id=v_claim AND v_result.status IN ('failed_roster','failed_priority') AND v_result.failure_reason ILIKE CASE p_case
      WHEN 'ineligible' THEN CASE p_slot WHEN 'ir' THEN '%IR eligible%' ELSE '%fewer than 65%' END
      WHEN 'limit' THEN '%Weekly add limit reached%' WHEN 'game_lock' THEN '%game has already started%'
      WHEN 'capacity' THEN CASE p_slot WHEN 'ir' THEN '%IR slots are full%' ELSE '%taxi squad is full%' END
      WHEN 'active_full' THEN '%active roster over the limit%' WHEN 'moved' THEN '%no longer in the selected roster slot%'
      WHEN 'budget' THEN '%Insufficient FAAB%' WHEN 'late_failure' THEN '%Pickup count rejected%'
      WHEN 'lock_error' THEN '%Pickup count rejected%'
    END,'claim '||p_slot||' '||p_case||' rejects');
    PERFORM pg_temp.check_rules(pg_temp.pickup_snapshot(f.league_id,v_claim)=v_before,'claim '||p_slot||' '||p_case||' preserves roster, slots, counts, budget and claim selection');
    PERFORM pg_temp.check_rules((SELECT status=v_result.status AND processed_at IS NOT NULL AND failure_reason IS NOT NULL FROM waiver_claims WHERE id=v_claim),'claim '||p_slot||' '||p_case||' records only the failed outcome');
  ELSE
    PERFORM pg_temp.check_rules(v_result.claim_id=v_claim AND v_result.status='succeeded','claim '||p_slot||' '||p_case||' succeeds');
  END IF;
  IF NOT v_reject THEN
    PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE id=v_drop_row)
      AND EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=v_incoming AND is_on_ir=v_to_ir AND is_on_taxi=v_to_taxi),'claim '||p_slot||' '||p_case||' replaces exactly the selected slot');
    PERFORM pg_temp.check_rules((SELECT sum(add_count)=1 FROM weekly_add_counts WHERE league_id=f.league_id),'claim '||p_slot||' '||p_case||' consumes one add');
    PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM roster_transactions WHERE league_id=f.league_id),'claim '||p_slot||' '||p_case||' writes one drop and one add');
  END IF;
END;
$$;

SELECT pg_temp.inactive_claim(slot,scenario) FROM unnest(ARRAY['taxi','ir']) slot
  CROSS JOIN unnest(ARRAY['success','active_room','ineligible','limit','game_lock','capacity','active_full','moved','budget','late_failure','lock_error']) scenario
  WHERE current_setting('tests.pickup_path') IN ('all','claim')
    OR (current_setting('tests.pickup_path')='inactive_locks' AND scenario='lock_error');

CREATE FUNCTION pg_temp.immediate_pickup_rejected(p_slot text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_player uuid:=gen_random_uuid();
  v_drop uuid:=gen_random_uuid();
  v_drop_row uuid;
  v_before jsonb;
  v_status league_status;
  v_code text;
  v_message text;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,public.current_season_year_et());
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,injury_status)
    SELECT id,'Immediate','Pickup','PG',ARRAY['PG'],0,'Out' FROM unnest(ARRAY[v_player,v_drop]) id;
  FOREACH v_status IN ARRAY enum_range(NULL::league_status) LOOP
    UPDATE leagues SET status=v_status WHERE id=f.league_id;
    v_code:=NULL;
    BEGIN
      PERFORM private.assert_free_agent_waiver_cleared(f.league_id,f.season_id,v_player);
    EXCEPTION WHEN OTHERS THEN
      v_code:=SQLSTATE;v_message:=SQLERRM;
    END;
    PERFORM pg_temp.check_rules(v_code='PA002' AND v_message='Every pickup requires a scheduled waiver claim. Submit a claim instead.',p_slot||' immediate guard rejects '||v_status);
  END LOOP;
  UPDATE leagues SET status='active',taxi_slots=1,ir_slots=1 WHERE id=f.league_id;
  IF p_slot='taxi' THEN
    PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',v_drop);
  END IF;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi,is_on_ir)
    VALUES(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',p_slot='taxi',p_slot='ir') RETURNING id INTO v_drop_row;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  v_before:=pg_temp.pickup_snapshot(f.league_id);
  v_code:=NULL;
  BEGIN
    PERFORM public.drop_and_add_free_agent_atomic(v_drop_row,f.member_ids[1],f.league_id,v_player);
  EXCEPTION WHEN OTHERS THEN
    v_code:=SQLSTATE;v_message:=SQLERRM;
  END;
  PERFORM pg_temp.check_rules(v_code='PA002' AND v_message='Every pickup requires a scheduled waiver claim. Submit a claim instead.',p_slot||' original immediate swap rejects exactly as main');
  PERFORM pg_temp.check_rules(pg_temp.pickup_snapshot(f.league_id)=v_before,p_slot||' rejected immediate swap preserves all rows');
END;
$$;
SELECT pg_temp.immediate_pickup_rejected(slot) FROM unnest(ARRAY['taxi','ir']) slot
  WHERE current_setting('tests.pickup_path') IN ('all','guard');

CREATE FUNCTION pg_temp.inactive_drop_after_trade(p_slot text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_drop uuid:=gen_random_uuid();
  v_incoming uuid:=gen_random_uuid();
  v_offer uuid:=gen_random_uuid();
  v_claim uuid;
  v_trade uuid;
  v_before jsonb;
  v_result record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claims','{}',true);
  SELECT * INTO f FROM pg_temp.rules_fixture(2,public.current_season_year_et());
  UPDATE leagues SET allow_inactive_trades=true,taxi_slots=1,ir_slots=1,weekly_add_limit=10 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,injury_status)
    SELECT id,'Trade','Pickup','PG',ARRAY['PG'],0,'Out' FROM unnest(ARRAY[v_drop,v_incoming,v_offer]) id;
  IF p_slot='taxi' THEN
    PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',v_drop);
  END IF;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi,is_on_ir)
    VALUES(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',p_slot='taxi',p_slot='ir');
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[2],v_offer,'draft');
  v_claim:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],v_incoming,v_drop,f.user_ids[1],p_to_taxi=>p_slot='taxi',p_to_ir=>p_slot='ir');
  SET CONSTRAINTS ALL IMMEDIATE;
  ALTER TABLE trade_items DISABLE TRIGGER guard_trade_item_plan_reservations;
  SET CONSTRAINTS ALL DEFERRED;
  v_trade:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[v_drop],'{}','{}','{}',NULL,NULL,0,1);
  SET CONSTRAINTS ALL IMMEDIATE;
  ALTER TABLE trade_items ENABLE TRIGGER guard_trade_item_plan_reservations;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM public.accept_trade_atomic(v_trade,f.member_ids[2]);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=v_trade;
  PERFORM public.complete_accepted_trade_atomic(v_trade);
  PERFORM pg_temp.check_rules((SELECT status='completed' FROM trades WHERE id=v_trade),p_slot||' trade completes');
  PERFORM pg_temp.check_rules((SELECT status='pending' AND drop_player_id=v_drop FROM waiver_claims WHERE id=v_claim),p_slot||' keeps the original pending drop');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND member_id=f.member_ids[1] AND player_id=v_drop),p_slot||' loses ownership before processing');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM notification_outbox WHERE dedupe_key='trade_claim_cancelled:'||v_claim),p_slot||' sends no claim cancellation');
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=v_claim;
  v_before:=pg_temp.pickup_snapshot(f.league_id,v_claim);
  SELECT * INTO v_result FROM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  PERFORM pg_temp.check_rules(v_result.claim_id=v_claim AND v_result.status='failed_roster'
    AND v_result.failure_reason='Drop player is no longer on this active roster.',p_slot||' uses the existing invalid-drop result');
  PERFORM pg_temp.check_rules(pg_temp.pickup_snapshot(f.league_id,v_claim)=v_before,p_slot||' failed processing preserves all roster and claim selections');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM notification_outbox WHERE data->>'claimId'=v_claim::text AND event_type='waiver_claim_lost'
    AND body='Drop player is no longer on this active roster.'),p_slot||' sends the existing invalid-drop notification');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=v_incoming)
    AND NOT EXISTS(SELECT 1 FROM roster_transactions WHERE related_claim_id=v_claim),p_slot||' never awards or drops another player');
END;
$$;
SELECT pg_temp.inactive_drop_after_trade(slot) FROM unnest(ARRAY['taxi','ir']) slot
  WHERE current_setting('tests.pickup_path') IN ('all','trade');
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
