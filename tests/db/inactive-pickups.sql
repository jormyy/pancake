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
  v_reject boolean:=p_case NOT IN ('success','active_room','game_lock');
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
      WHEN 'limit' THEN '%Weekly add limit reached%'
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
    PERFORM pg_temp.check_rules((SELECT count(*)=CASE WHEN p_slot='taxi' THEN 1 ELSE 0 END FROM league_member_taxi_exits WHERE league_id=f.league_id AND member_id=f.member_ids[1] AND player_id=v_drop),'claim '||p_slot||' '||p_case||' records a taxi exit only for a Taxi drop');
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
    AND v_result.failure_reason='Drop player is no longer on this roster.',p_slot||' uses the existing invalid-drop result');
  PERFORM pg_temp.check_rules(pg_temp.pickup_snapshot(f.league_id,v_claim)=v_before,p_slot||' failed processing preserves all roster and claim selections');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM notification_outbox WHERE data->>'claimId'=v_claim::text AND event_type='waiver_claim_lost'
    AND body='Drop player is no longer on this roster.'),p_slot||' sends the existing invalid-drop notification');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=v_incoming)
    AND NOT EXISTS(SELECT 1 FROM roster_transactions WHERE related_claim_id=v_claim),p_slot||' never awards or drops another player');
END;
$$;
SELECT pg_temp.inactive_drop_after_trade(slot) FROM unnest(ARRAY['taxi','ir']) slot
  WHERE current_setting('tests.pickup_path') IN ('all','trade');
CREATE FUNCTION pg_temp.inactive_drop_game(p_slot text, p_case text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_drop uuid:=gen_random_uuid();
  v_incoming uuid:=gen_random_uuid();
  v_team text:='T'||left(md5(v_drop::text),8);
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
  v_drop_row uuid;
  v_claim uuid;
  v_before jsonb;
  v_result record;
  v_label text:='game '||p_slot||' '||p_case;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,public.current_season_year_et());
  UPDATE leagues SET roster_size=1,taxi_slots=1,ir_slots=1,weekly_add_limit=10 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,injury_status,nba_team)
    VALUES(v_drop,'Game','Drop','PG',ARRAY['PG'],0,0,'Out',v_team),(v_incoming,'Game','Pickup','PG',ARRAY['PG'],0,0,'Out',NULL);
  IF p_slot='taxi' THEN
    PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',v_drop);
  END IF;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir,is_on_taxi)
    VALUES(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',p_slot='ir',p_slot='taxi') RETURNING id INTO v_drop_row;
  INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    SELECT v_drop::text,public.current_season_year_et(),1,game.day,v_team,'OPP',game.status,game.tip
      FROM (VALUES
        ('final_evening',v_today-1,'Final',now()-interval '6 hours'),
        ('final_today',v_today,'Final',now()-interval '3 hours'),
        ('postponed',v_today,'Postponed',now()-interval '1 hour'),
        ('in_progress',v_today,'InProgress',now()-interval '1 hour'),
        ('in_progress_overnight',v_today-1,'InProgress',now()-interval '3 hours'),
        ('tipped_not_final',v_today,'Scheduled',now()-interval '1 minute')
      ) AS game(scenario,day,status,tip) WHERE game.scenario=p_case;
  IF p_case IN ('final_today','in_progress','tipped_not_final') THEN
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
      VALUES(public.current_season_year_et(),1,v_today-1,v_today+5) ON CONFLICT DO NOTHING;
    INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,game_date,week_number,slot_type,is_auto_set)
      SELECT f.member_ids[1],f.league_id,f.season_id,v_drop,v_today+offset_days,1,'PG',false FROM unnest(ARRAY[-1,0,1]) offset_days;
  END IF;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  v_claim:=public.create_waiver_claim_atomic(p_league_id=>f.league_id,p_member_id=>f.member_ids[1],p_player_id=>v_incoming,
    p_drop_player_id=>v_drop,p_user_id=>f.user_ids[1],p_to_ir=>p_slot='ir',p_to_taxi=>p_slot='taxi');
  PERFORM pg_temp.check_rules(v_claim IS NOT NULL,v_label||' submit is allowed');
  PERFORM public.edit_waiver_claim_atomic(v_claim,f.member_ids[1],f.user_ids[1],v_drop,0,NULL,p_slot='ir',p_slot='taxi');
  PERFORM pg_temp.check_rules((SELECT status='pending' AND drop_player_id=v_drop FROM waiver_claims WHERE id=v_claim),v_label||' edit is allowed');
  UPDATE waiver_claims SET process_date=v_today-1 WHERE id=v_claim;
  SELECT * INTO v_result FROM public.process_next_waiver_claim_atomic(v_today);
  PERFORM pg_temp.check_rules(v_result.claim_id=v_claim AND v_result.status='succeeded',v_label||' succeeds at processing');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE id=v_drop_row)
    AND EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=v_incoming AND is_on_ir=(p_slot='ir') AND is_on_taxi=(p_slot='taxi')),v_label||' replaces the drop');
  PERFORM pg_temp.check_rules((SELECT count(*)=CASE WHEN p_slot='taxi' THEN 1 ELSE 0 END FROM league_member_taxi_exits WHERE league_id=f.league_id AND player_id=v_drop),v_label||' records the taxi exit only for Taxi');
  IF p_case IN ('final_today','in_progress','tipped_not_final') THEN
    PERFORM pg_temp.check_rules((SELECT array_agg(game_date ORDER BY game_date)=ARRAY[v_today-1,v_today] FROM weekly_lineups WHERE league_id=f.league_id AND player_id=v_drop),v_label||' keeps finished and started lineup rows and clears the future row');
  END IF;
END;
$$;
SELECT pg_temp.inactive_drop_game(slot,scenario) FROM unnest(ARRAY['taxi','ir']) slot
  CROSS JOIN unnest(ARRAY['final_evening','final_today','postponed']) scenario
  WHERE current_setting('tests.pickup_path') IN ('all','game_final');
SELECT pg_temp.inactive_drop_game(slot,scenario) FROM unnest(ARRAY['taxi','ir']) slot
  CROSS JOIN unnest(ARRAY['in_progress','in_progress_overnight','tipped_not_final']) scenario
  WHERE current_setting('tests.pickup_path') IN ('all','game_live');

CREATE FUNCTION pg_temp.pickup_own_game(p_destination text, p_drop_slot text, p_case text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_drop uuid:=gen_random_uuid();
  v_incoming uuid:=gen_random_uuid();
  v_team text:='T'||left(md5(v_incoming::text),8);
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
  v_drop_row uuid;
  v_claim uuid;
  v_result record;
  v_label text:='pickup own game '||p_destination||' after '||p_drop_slot||' drop '||p_case;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,public.current_season_year_et());
  UPDATE leagues SET roster_size=1,taxi_slots=1,ir_slots=1,weekly_add_limit=10 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,injury_status,nba_team)
    VALUES(v_drop,'Own','Drop','PG',ARRAY['PG'],0,0,'Out',NULL),(v_incoming,'Own','Pickup','PG',ARRAY['PG'],0,0,'Out',v_team);
  IF p_drop_slot='taxi' THEN
    PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',v_drop);
  END IF;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir,is_on_taxi)
    VALUES(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',p_drop_slot='ir',p_drop_slot='taxi') RETURNING id INTO v_drop_row;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  v_claim:=public.create_waiver_claim_atomic(p_league_id=>f.league_id,p_member_id=>f.member_ids[1],p_player_id=>v_incoming,
    p_drop_player_id=>v_drop,p_user_id=>f.user_ids[1],p_to_ir=>p_destination='ir',p_to_taxi=>p_destination='taxi');
  INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    SELECT v_incoming::text,public.current_season_year_et(),1,game.day,v_team,'OPP',game.status,game.tip
      FROM (VALUES
        ('in_progress',v_today,'InProgress',now()-interval '1 hour'),
        ('final_today',v_today,'Final',now()-interval '3 hours'),
        ('final_evening',v_today-1,'Final',now()-interval '6 hours')
      ) AS game(scenario,day,status,tip) WHERE game.scenario=p_case;
  UPDATE waiver_claims SET process_date=v_today-1 WHERE id=v_claim;
  SELECT * INTO v_result FROM public.process_next_waiver_claim_atomic(v_today);
  PERFORM pg_temp.check_rules(v_result.claim_id=v_claim AND v_result.status='succeeded',v_label||' succeeds: '||coalesce(v_result.failure_reason,'no reason'));
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE id=v_drop_row)
    AND EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=v_incoming AND is_on_ir=(p_destination='ir') AND is_on_taxi=(p_destination='taxi')),v_label||' places the pickup in the chosen slot');
END;
$$;
SELECT pg_temp.pickup_own_game(destination,drop_slot,scenario) FROM unnest(ARRAY['taxi','ir']) destination
  CROSS JOIN unnest(ARRAY['taxi','ir']) drop_slot
  CROSS JOIN unnest(ARRAY['in_progress','final_today','final_evening']) scenario
  WHERE current_setting('tests.pickup_path') IN ('all','pickup_game');

CREATE FUNCTION pg_temp.active_drop_ignores_game()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_drop uuid:=gen_random_uuid();
  v_incoming uuid:=gen_random_uuid();
  v_team text:='T'||left(md5(v_drop::text),8);
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
  v_claim uuid;
  v_result record;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,public.current_season_year_et());
  UPDATE leagues SET roster_size=1,weekly_add_limit=10 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,nba_team)
    VALUES(v_drop,'Active','Live','PG',ARRAY['PG'],v_team),(v_incoming,'Active','Pickup','PG',ARRAY['PG'],NULL);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft');
  INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES(v_drop::text,public.current_season_year_et(),1,v_today,v_team,'OPP','InProgress',now()-interval '1 hour');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  v_claim:=public.create_waiver_claim_atomic(p_league_id=>f.league_id,p_member_id=>f.member_ids[1],p_player_id=>v_incoming,p_drop_player_id=>v_drop,p_user_id=>f.user_ids[1]);
  UPDATE waiver_claims SET process_date=v_today-1 WHERE id=v_claim;
  SELECT * INTO v_result FROM public.process_next_waiver_claim_atomic(v_today);
  PERFORM pg_temp.check_rules(v_result.claim_id=v_claim AND v_result.status='succeeded','Active drop keeps ignoring the game lock');
END;
$$;
SELECT pg_temp.active_drop_ignores_game() WHERE current_setting('tests.pickup_path') IN ('all','legacy_locks');

CREATE FUNCTION pg_temp.rpc_error(p_command text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_command;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE||' '||SQLERRM;
END;
$$;

CREATE FUNCTION pg_temp.cure_claim(p_slot text, p_other text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_active uuid:=gen_random_uuid();
  v_extra uuid:=gen_random_uuid();
  v_drop uuid:=gen_random_uuid();
  v_other uuid:=gen_random_uuid();
  v_incoming uuid:=gen_random_uuid();
  v_incoming2 uuid:=gen_random_uuid();
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
  v_drop_row uuid;
  v_claim uuid;
  v_before jsonb;
  v_result record;
  v_error text;
  v_code text:=CASE p_other WHEN 'ir' THEN 'PA005' WHEN 'taxi' THEN 'PA009' WHEN 'active_limit' THEN 'PA003' END;
  v_problem text:=CASE p_other WHEN 'ir' THEN 'Second Illegal is no longer eligible for IR%' WHEN 'taxi' THEN 'Second Illegal is no longer taxi-eligible%' WHEN 'active_limit' THEN 'Your active roster is 1 over%' END;
  v_label text:='cure '||p_slot||' with '||coalesce(p_other,'nothing else illegal');
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,public.current_season_year_et());
  UPDATE leagues SET roster_size=2,taxi_slots=2,ir_slots=2,weekly_add_limit=10 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,injury_status)
    VALUES(v_active,'Active','One','PG',ARRAY['PG'],4,200,NULL),(v_extra,'Active','Two','PG',ARRAY['PG'],4,200,NULL),
      (v_drop,'Chosen','Drop','PG',ARRAY['PG'],0,0,'Out'),(v_other,'Second','Illegal','PG',ARRAY['PG'],0,0,'Out'),
      (v_incoming,'Cure','Pickup','PG',ARRAY['PG'],0,0,'Out'),(v_incoming2,'Cure','Blocked','PG',ARRAY['PG'],0,0,'Out');
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],v_active,'draft');
  IF p_slot='taxi' THEN
    PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',v_drop);
  END IF;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir,is_on_taxi)
    VALUES(f.league_id,f.season_id,f.member_ids[1],v_drop,'draft',p_slot='ir',p_slot='taxi') RETURNING id INTO v_drop_row;
  IF p_other='taxi' THEN
    PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],v_other,'draft',v_other);
  END IF;
  IF p_other IN ('ir','taxi') THEN
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir,is_on_taxi)
      VALUES(f.league_id,f.season_id,f.member_ids[1],v_other,'draft',p_other='ir',p_other='taxi');
  END IF;
  IF p_slot='ir' THEN UPDATE players SET injury_status=NULL WHERE id=v_drop;
  ELSE UPDATE players SET years_exp=4,career_regular_season_games=200 WHERE id=v_drop; END IF;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  v_claim:=public.create_waiver_claim_atomic(p_league_id=>f.league_id,p_member_id=>f.member_ids[1],p_player_id=>v_incoming,p_drop_player_id=>v_drop,p_user_id=>f.user_ids[1]);
  PERFORM pg_temp.check_rules(v_claim IS NOT NULL,v_label||' submit passes');
  PERFORM public.edit_waiver_claim_atomic(v_claim,f.member_ids[1],f.user_ids[1],v_drop,0,NULL,false,false);
  PERFORM pg_temp.check_rules(true,v_label||' edit passes');
  v_error:=pg_temp.rpc_error(format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,NULL,%L)',f.league_id,f.member_ids[1],v_incoming2,f.user_ids[1]));
  PERFORM pg_temp.check_rules(v_error LIKE CASE p_slot WHEN 'ir' THEN 'PA005 Chosen Drop%' ELSE 'PA009 Chosen Drop%' END,v_label||' still blocks a claim without that drop: '||coalesce(v_error,'allowed'));
  v_error:=pg_temp.rpc_error(format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,%L,%L)',f.league_id,f.member_ids[1],v_incoming2,v_active,f.user_ids[1]));
  PERFORM pg_temp.check_rules(v_error LIKE CASE p_slot WHEN 'ir' THEN 'PA005 Chosen Drop%' ELSE 'PA009 Chosen Drop%' END,v_label||' still blocks a claim dropping someone else: '||coalesce(v_error,'allowed'));
  IF p_other IS NOT NULL THEN
    IF p_other='ir' THEN UPDATE players SET injury_status=NULL WHERE id=v_other;
    ELSIF p_other='taxi' THEN UPDATE players SET years_exp=4,career_regular_season_games=200 WHERE id=v_other;
    ELSE UPDATE leagues SET roster_size=0 WHERE id=f.league_id; END IF;
    v_error:=pg_temp.rpc_error(format('SELECT public.edit_waiver_claim_atomic(%L,%L,%L,%L,0,NULL,false,false)',v_claim,f.member_ids[1],f.user_ids[1],v_drop));
    PERFORM pg_temp.check_rules(v_error LIKE v_code||' '||v_problem,v_label||' edit blocks with '||v_code||': '||coalesce(v_error,'allowed'));
    v_error:=pg_temp.rpc_error(format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,%L,%L)',f.league_id,f.member_ids[1],v_incoming2,v_drop,f.user_ids[1]));
    PERFORM pg_temp.check_rules(v_error LIKE v_code||' '||v_problem,v_label||' submit blocks with '||v_code||': '||coalesce(v_error,'allowed'));
  END IF;
  UPDATE waiver_claims SET process_date=v_today-1 WHERE id=v_claim;
  v_before:=pg_temp.pickup_snapshot(f.league_id,v_claim);
  SELECT * INTO v_result FROM public.process_next_waiver_claim_atomic(v_today);
  IF p_other IS NULL THEN
    PERFORM pg_temp.check_rules(v_result.claim_id=v_claim AND v_result.status='succeeded',v_label||' processing succeeds');
    PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE id=v_drop_row)
      AND EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=v_incoming),v_label||' processing replaces the illegal player');
    PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_problems(f.league_id,f.season_id,f.member_ids[1])),v_label||' leaves a legal roster');
  ELSE
    PERFORM pg_temp.check_rules(v_result.claim_id=v_claim AND v_result.status='failed_roster' AND v_result.failure_reason LIKE v_problem,v_label||' processing fails on the other problem only: '||coalesce(v_result.failure_reason,'none'));
    PERFORM pg_temp.check_rules(pg_temp.pickup_snapshot(f.league_id,v_claim)=v_before,v_label||' failed processing preserves all rows');
  END IF;
END;
$$;
SELECT pg_temp.cure_claim('ir',NULL) WHERE current_setting('tests.pickup_path') IN ('all','cure_ir');
SELECT pg_temp.cure_claim('taxi',NULL) WHERE current_setting('tests.pickup_path') IN ('all','cure_taxi');
SELECT pg_temp.cure_claim('ir',other) FROM unnest(ARRAY['ir','taxi','active_limit']) other WHERE current_setting('tests.pickup_path') IN ('all','cure_ir_other');
SELECT pg_temp.cure_claim('taxi',other) FROM unnest(ARRAY['ir','taxi','active_limit']) other WHERE current_setting('tests.pickup_path') IN ('all','cure_taxi_other');
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
