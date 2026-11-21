BEGIN;
\ir rules-support.sql

CREATE FUNCTION pg_temp.reject_immediate(p_command text, p_message text, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_message text;
BEGIN
  BEGIN
    EXECUTE 'SET CONSTRAINTS check_accepted_trade_capacity IMMEDIATE';
    EXECUTE p_command;
    EXECUTE 'SET CONSTRAINTS check_accepted_trade_capacity DEFERRED';
  EXCEPTION WHEN OTHERS THEN
    v_message := SQLERRM;
  END;
  PERFORM pg_temp.check_rules(v_message LIKE p_message, p_label || COALESCE(': ' || v_message, ': unexpected success'));
END;
$$;

DO $$
DECLARE
  f record;
  v_players uuid[];
  trade_id uuid;
  v_message text;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9714);
  UPDATE public.leagues
     SET roster_size = 20, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  SELECT array_agg(gen_random_uuid()) INTO v_players FROM generate_series(1, 25);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Grow', id::text, 'PG', ARRAY['PG'] FROM unnest(v_players) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[1], id, 'verification' FROM unnest(v_players[1:19]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[2], id, 'verification' FROM unnest(v_players[20:21]) id;
  trade_id := public.propose_trade_atomic(
    f.league_id, f.season_id, f.member_ids[2], f.member_ids[1],
    ARRAY[v_players[20]], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 0, 5);
  PERFORM public.accept_trade_atomic(trade_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'accepted' FROM public.trades WHERE id = trade_id),
    'the +1 hold is accepted at the limit');
  PERFORM set_config('pancake.trade_hold_baseline', '', true);
  BEGIN
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES (f.league_id, f.season_id, f.member_ids[1], v_players[22], 'verification'),
             (f.league_id, f.season_id, f.member_ids[1], v_players[23], 'verification');
    DELETE FROM public.roster_players
      WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = v_players[1];
    EXECUTE 'SET CONSTRAINTS check_accepted_trade_capacity IMMEDIATE';
    EXECUTE 'SET CONSTRAINTS check_accepted_trade_capacity DEFERRED';
  EXCEPTION WHEN OTHERS THEN
    v_message := SQLERRM;
  END;
  PERFORM pg_temp.check_rules(
    v_message LIKE '%needs this roster spot%',
    'a multi-statement transaction that grows a hold is rejected' || COALESCE(': ' || v_message, ': unexpected success'));
END $$;

DO $$
DECLARE
  f record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  p5 uuid := gen_random_uuid();
  v_trade_id uuid;
  items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9701);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Hold', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[p1, p2, p3, p4, p5]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification'),
           (f.league_id, f.season_id, f.member_ids[1], p2, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p3, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p4, 'verification');
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', f.user_ids[1], 'role', 'authenticated')::text, true);
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'playerId', p3),
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'faabAmount', 5));
  v_trade_id := public.propose_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    '{}'::uuid[], ARRAY[p3], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);
  PERFORM pg_temp.check_rules(
    (SELECT accepted_at IS NOT NULL FROM public.trade_participants
      WHERE trade_participants.trade_id = v_trade_id AND member_id = f.member_ids[1]),
    'the proposer is accepted on send');
  PERFORM pg_temp.check_rules(
    (SELECT jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 1),
    'the proposer hold is visible to the read-only check');
  PERFORM pg_temp.reject_immediate(
    format('INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(%L,%L,%L,%L,''verification'')',
      f.league_id, f.season_id, f.member_ids[1], p5),
    '%Your accepted trade with Rules team 2 needs this roster spot. Drop a player or withdraw your acceptance.%',
    'the proposer hold blocks a roster growth');
  PERFORM pg_temp.check_rules(
    NOT EXISTS (SELECT 1 FROM public.roster_players WHERE league_id = f.league_id AND player_id = p5),
    'the blocked add leaves no roster row');
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

DO $$
DECLARE
  f record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  p5 uuid := gen_random_uuid();
  p6 uuid := gen_random_uuid();
  v_trade_id uuid;
  items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9702);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Multi', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[p1, p2, p3, p4, p5, p6]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification'),
           (f.league_id, f.season_id, f.member_ids[1], p2, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p3, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p4, 'verification'),
           (f.league_id, f.season_id, f.member_ids[3], p5, 'verification'),
           (f.league_id, f.season_id, f.member_ids[3], p6, 'verification');
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'playerId', p1),
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[3], 'playerId', p3),
    jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[1], 'playerId', p5));
  v_trade_id := public.propose_multi_team_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], ARRAY[f.member_ids[2], f.member_ids[3]], items);
  PERFORM public.accept_trade_atomic(v_trade_id, f.member_ids[2]);
  PERFORM public.accept_trade_atomic(v_trade_id, f.member_ids[3]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'accepted' FROM public.trades WHERE id = v_trade_id),
    'a multisided trade accepts when every team fits');
  PERFORM public.complete_accepted_trade_atomic(v_trade_id);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'completed' FROM public.trades WHERE id = v_trade_id),
    'the multisided trade completes');
  PERFORM pg_temp.check_rules(
    (SELECT member_id = f.member_ids[2] FROM public.roster_players
      WHERE league_id = f.league_id AND league_season_id = f.season_id AND player_id = p1)
    AND (SELECT member_id = f.member_ids[3] FROM public.roster_players
      WHERE league_id = f.league_id AND league_season_id = f.season_id AND player_id = p3)
    AND (SELECT member_id = f.member_ids[1] FROM public.roster_players
      WHERE league_id = f.league_id AND league_season_id = f.season_id AND player_id = p5),
    'the multisided trade moves every player');
END $$;

DO $$
DECLARE
  f record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  p5 uuid := gen_random_uuid();
  offer_one uuid;
  offer_two uuid;
  items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9703);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Overlap', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[p1, p2, p3, p4, p5]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p2, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p3, 'verification'),
           (f.league_id, f.season_id, f.member_ids[3], p4, 'verification'),
           (f.league_id, f.season_id, f.member_ids[3], p5, 'verification');
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'playerId', p2),
    jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[2], 'playerId', p4),
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[3], 'faabAmount', 5));
  offer_one := public.propose_multi_team_trade_atomic(
    f.league_id, f.season_id, f.member_ids[2], ARRAY[f.member_ids[1], f.member_ids[3]], items);
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'playerId', p3),
    jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[2], 'playerId', p5),
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[3], 'faabAmount', 5));
  offer_two := public.propose_multi_team_trade_atomic(
    f.league_id, f.season_id, f.member_ids[2], ARRAY[f.member_ids[1], f.member_ids[3]], items);
  PERFORM public.accept_trade_atomic(offer_one, f.member_ids[1]);
  PERFORM public.accept_trade_atomic(offer_two, f.member_ids[1]);
  PERFORM pg_temp.check_rules(
    (SELECT count(*) = 2 FROM public.trade_participants
      WHERE trade_participants.trade_id IN (offer_one, offer_two) AND member_id = f.member_ids[1] AND accepted_at IS NOT NULL),
    'two overlapping pending offers are both accepted by the same team');
  PERFORM pg_temp.check_rules(
    (SELECT jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0),
    'overlapping pending holds do not add together');
  PERFORM pg_temp.reject_rules(
    format('SELECT public.accept_trade_atomic(%L,%L)', offer_one, f.member_ids[3]),
    '%Rules team 1''s accepted trade with Rules team 2 and Rules team 3 needs the roster spot this trade would use. Rules team 1 has to make room or withdraw that acceptance first.%',
    'a unanimous-making acceptance is blocked when another hold no longer fits');
  PERFORM pg_temp.check_rules(
    (SELECT status = 'pending' FROM public.trades WHERE id = offer_one)
    AND (SELECT accepted_at IS NULL FROM public.trade_participants
      WHERE trade_id = offer_one AND member_id = f.member_ids[3]),
    'the blocked unanimous acceptance preserves state');
  PERFORM public.retract_trade_acceptance_atomic(offer_two, f.member_ids[1], f.user_ids[1]);
  PERFORM pg_temp.check_rules(
    (SELECT accepted_at IS NULL FROM public.trade_participants
      WHERE trade_id = offer_two AND member_id = f.member_ids[1])
    AND (SELECT accepted_at IS NOT NULL FROM public.trade_participants
      WHERE trade_id = offer_one AND member_id = f.member_ids[1]),
    'retracting one acceptance keeps the other');
  PERFORM public.accept_trade_atomic(offer_one, f.member_ids[3]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'accepted' FROM public.trades WHERE id = offer_one),
    'reacceptance after a retraction completes the trade');
  PERFORM pg_temp.reject_rules(
    format('SELECT public.retract_trade_acceptance_atomic(%L,%L,%L)', offer_one, f.member_ids[1], f.user_ids[1]),
    '%Every team has accepted this trade, so acceptance can no longer be withdrawn.%',
    'a stale retraction after unanimity is rejected');
  PERFORM pg_temp.reject_rules(
    format('SELECT public.retract_trade_acceptance_atomic(%L,%L,%L)', offer_two, f.member_ids[3], f.user_ids[3]),
    '%You have not accepted this trade.%',
    'a retraction without an acceptance is rejected');
END $$;

DO $$
DECLARE
  f record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  p5 uuid := gen_random_uuid();
  p6 uuid := gen_random_uuid();
  p7 uuid := gen_random_uuid();
  v_trade_id uuid;
  items jsonb;
  opening_balance int;
  roster_before int;
  claims_before int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9704);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 1, taxi_slots = 1, waiver_mode = 'faab',
         faab_starting_budget = 100, trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.faab_balances(league_id, league_season_id, member_id, balance)
    VALUES (f.league_id, f.season_id, f.member_ids[1], 100), (f.league_id, f.season_id, f.member_ids[2], 100)
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET balance = 100;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, career_regular_season_games)
    VALUES (p1, 'Blocked', 'One', 'PG', ARRAY['PG'], 'Healthy', 0),
           (p2, 'Blocked', 'Two', 'PG', ARRAY['PG'], 'Healthy', 0),
           (p3, 'Blocked', 'Three', 'PG', ARRAY['PG'], 'Healthy', 0),
           (p4, 'Blocked', 'Four', 'PG', ARRAY['PG'], 'Healthy', 0),
           (p5, 'Blocked', 'Five', 'PG', ARRAY['PG'], 'Healthy', 0),
           (p6, 'Blocked', 'Six', 'PG', ARRAY['PG'], 'Out', 0),
           (p7, 'Blocked', 'Seven', 'PG', ARRAY['PG'], 'Healthy', 0);
  PERFORM private.authorize_taxi_acquisition(f.league_id, f.season_id, f.member_ids[1], p7, 'waiver', p7);
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir, is_on_taxi)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification', false, false),
           (f.league_id, f.season_id, f.member_ids[1], p6, 'verification', true, false),
           (f.league_id, f.season_id, f.member_ids[1], p7, 'verification', false, true),
           (f.league_id, f.season_id, f.member_ids[2], p3, 'verification', false, false),
           (f.league_id, f.season_id, f.member_ids[2], p4, 'verification', false, false);
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', f.user_ids[1], 'role', 'authenticated')::text, true);
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'playerId', p3),
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'faabAmount', 5));
  v_trade_id := public.propose_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    '{}'::uuid[], ARRAY[p3], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);
  PERFORM pg_temp.check_rules(
    (SELECT jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0),
    'the hold fits before the roster grows');
  opening_balance := private.available_faab_balance(f.league_id, f.season_id, f.member_ids[1]);
  roster_before := (SELECT count(*) FROM public.roster_players WHERE league_id = f.league_id AND member_id = f.member_ids[1]);
  claims_before := (SELECT count(*) FROM public.waiver_claims WHERE league_id = f.league_id);
  PERFORM pg_temp.reject_rules(
    format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,NULL,%L,0)', f.league_id, f.member_ids[1], p5, f.user_ids[1]),
    '%Your accepted trade with Rules team 2 needs this roster spot. Add a drop or withdraw your acceptance.%',
    'a waiver claim without a drop is blocked by the hold');
  PERFORM pg_temp.check_rules(
    (SELECT count(*) FROM public.waiver_claims WHERE league_id = f.league_id) = claims_before,
    'the blocked claim leaves no claim row');
  PERFORM pg_temp.reject_immediate(
    format('INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(%L,%L,%L,%L,''verification'')',
      f.league_id, f.season_id, f.member_ids[1], p5),
    '%Your accepted trade with Rules team 2 needs this roster spot. Drop a player or withdraw your acceptance.%',
    'a roster growth is blocked by the hold');
  PERFORM pg_temp.check_rules(
    (SELECT count(*) FROM public.roster_players WHERE league_id = f.league_id AND member_id = f.member_ids[1]) = roster_before
    AND private.available_faab_balance(f.league_id, f.season_id, f.member_ids[1]) = opening_balance,
    'the blocked add leaves roster and FAAB unchanged');
  PERFORM pg_temp.reject_immediate(
    format('SELECT public.toggle_ir_atomic(%L,false,%L)',
      (SELECT id FROM public.roster_players WHERE league_id = f.league_id AND player_id = p6), f.user_ids[1]),
    '%Your accepted trade with Rules team 2 needs this roster spot. Drop a player or withdraw your acceptance.%',
    'an IR return is blocked by the hold');
  PERFORM pg_temp.check_rules(
    (SELECT is_on_ir FROM public.roster_players WHERE league_id = f.league_id AND player_id = p6),
    'the blocked IR return leaves the player on IR');
  PERFORM pg_temp.reject_immediate(
    format('SELECT public.toggle_taxi_atomic(%L,false,%L)',
      (SELECT id FROM public.roster_players WHERE league_id = f.league_id AND player_id = p7), f.user_ids[1]),
    '%Your accepted trade with Rules team 2 needs this roster spot. Drop a player or withdraw your acceptance.%',
    'a taxi return is blocked by the hold');
  PERFORM pg_temp.check_rules(
    (SELECT is_on_taxi FROM public.roster_players WHERE league_id = f.league_id AND player_id = p7),
    'the blocked taxi return leaves the player on taxi');
  PERFORM public.create_waiver_claim_atomic(f.league_id, f.member_ids[1], p5, p1, f.user_ids[1], 0);
  PERFORM pg_temp.check_rules(
    (SELECT count(*) = 1 FROM public.waiver_claims WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND status = 'pending'),
    'a claim with a drop is allowed when it preserves room');
  PERFORM public.cancel_waiver_claim_atomic(
    (SELECT id FROM public.waiver_claims WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND status = 'pending'),
    f.member_ids[1], f.user_ids[1]);
  PERFORM public.drop_player_atomic(
    (SELECT id FROM public.roster_players WHERE league_id = f.league_id AND player_id = p1));
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p5, 'verification');
  PERFORM pg_temp.check_rules(
    (SELECT member_id = f.member_ids[1] FROM public.roster_players WHERE league_id = f.league_id AND player_id = p5)
    AND NOT EXISTS (SELECT 1 FROM public.roster_players WHERE league_id = f.league_id AND player_id = p1),
    'a roster growth with a drop is allowed when it preserves room');
  PERFORM public.drop_player_atomic(
    (SELECT id FROM public.roster_players WHERE league_id = f.league_id AND player_id = p5));
  PERFORM pg_temp.check_rules(
    NOT EXISTS (SELECT 1 FROM public.roster_players WHERE league_id = f.league_id AND player_id = p5),
    'a drop is allowed under a hold');
  PERFORM public.set_player_slot_moves_atomic(
    f.member_ids[1], f.league_id, f.season_id, (now() AT TIME ZONE 'America/New_York')::date + 1, 1, '[]'::jsonb);
  PERFORM pg_temp.check_rules(
    (SELECT count(*) FROM public.roster_players WHERE league_id = f.league_id AND member_id = f.member_ids[1]) = 2,
    'a lineup change is allowed under a hold');
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

DO $$
DECLARE
  f record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  p5 uuid := gen_random_uuid();
  v_trade_id uuid;
  items jsonb;
  claim_one uuid;
  claim_two uuid;
  opening_balance int;
  opening_priority int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9705);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0, waiver_mode = 'faab',
         faab_starting_budget = 100, trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.faab_balances(league_id, league_season_id, member_id, balance)
    VALUES (f.league_id, f.season_id, f.member_ids[1], 100), (f.league_id, f.season_id, f.member_ids[2], 100)
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET balance = 100;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    VALUES (p1, 'Waiver', 'One', 'PG', ARRAY['PG']),
           (p2, 'Waiver', 'Two', 'PG', ARRAY['PG']),
           (p3, 'Waiver', 'Three', 'PG', ARRAY['PG']),
           (p4, 'Waiver', 'Four', 'PG', ARRAY['PG']),
           (p5, 'Waiver', 'Five', 'PG', ARRAY['PG']);
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p2, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p3, 'verification');
  INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, placed_on_waivers_at)
    VALUES (f.league_id, f.season_id, p4, now() - interval '5 days'),
           (f.league_id, f.season_id, p5, now() - interval '5 days');
  claim_one := public.create_waiver_claim_atomic(f.league_id, f.member_ids[1], p4, NULL, f.user_ids[1], 10, 1);
  claim_two := public.create_waiver_claim_atomic(f.league_id, f.member_ids[1], p5, p1, f.user_ids[1], 10, 2);
  UPDATE public.waiver_claims SET process_date = (now() AT TIME ZONE 'America/Los_Angeles')::date - 1
   WHERE id IN (claim_one, claim_two);
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'playerId', p2),
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'faabAmount', 5));
  v_trade_id := public.propose_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    '{}'::uuid[], ARRAY[p2], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);
  PERFORM public.accept_trade_atomic(v_trade_id, f.member_ids[2]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'accepted' FROM public.trades WHERE id = v_trade_id),
    'the trade becomes a hold after the claim was submitted');
  opening_balance := private.available_faab_balance(f.league_id, f.season_id, f.member_ids[1]);
  opening_priority := (SELECT priority FROM public.waiver_priorities WHERE league_id = f.league_id AND member_id = f.member_ids[1]);
  PERFORM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/Los_Angeles')::date);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'failed_roster' FROM public.waiver_claims WHERE id = claim_one)
    AND (SELECT failure_reason LIKE '%Your accepted trade with Rules team 2 needs this roster spot.%' FROM public.waiver_claims WHERE id = claim_one),
    'waiver execution fails cleanly when a hold arose after submission');
  PERFORM pg_temp.check_rules(
    private.available_faab_balance(f.league_id, f.season_id, f.member_ids[1]) = opening_balance
    AND (SELECT priority FROM public.waiver_priorities WHERE league_id = f.league_id AND member_id = f.member_ids[1]) = opening_priority,
    'the failed claim changes no FAAB or priority');
  PERFORM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/Los_Angeles')::date);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'succeeded' FROM public.waiver_claims WHERE id = claim_two)
    AND (SELECT member_id = f.member_ids[1] FROM public.roster_players WHERE league_id = f.league_id AND player_id = p5),
    'the next claim proceeds and succeeds with its drop');
END $$;

DO $$
DECLARE
  f record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  v_trade_id uuid;
  items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9706);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'member_vote', trade_veto_threshold_percent = 50,
         trade_veto_window_hours = 24, allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Release', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[p1, p2, p3, p4]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p2, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p3, 'verification');
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'playerId', p2),
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'faabAmount', 5));
  v_trade_id := public.propose_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    '{}'::uuid[], ARRAY[p2], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);
  PERFORM public.accept_trade_atomic(v_trade_id, f.member_ids[2]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'accepted' FROM public.trades WHERE id = v_trade_id)
    AND (SELECT jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0),
    'an accepted trade in the review window keeps holding');
  PERFORM public.veto_trade_atomic(v_trade_id, f.member_ids[3]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'vetoed' FROM public.trades WHERE id = v_trade_id)
    AND (SELECT jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0),
    'a veto releases the hold');
END $$;

DO $$
DECLARE
  f record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  v_trade_id uuid;
  items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9707);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Expire', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[p1, p2, p3, p4]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p2, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p3, 'verification');
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'playerId', p2),
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'faabAmount', 5));
  v_trade_id := public.propose_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    '{}'::uuid[], ARRAY[p2], '{}'::uuid[], '{}'::uuid[], NULL, now() + interval '1 hour', 5, 0);
  UPDATE public.trades SET expires_at = now() - interval '1 minute' WHERE id = v_trade_id;
  PERFORM public.expire_pending_trades_atomic();
  PERFORM pg_temp.check_rules(
    (SELECT status = 'expired' FROM public.trades WHERE id = v_trade_id)
    AND (SELECT jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0),
    'an expiry releases the hold');
END $$;

DO $$
DECLARE
  f record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  v_trade_id uuid;
  items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9708);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Withdraw', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[p1, p2, p3, p4]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p2, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p3, 'verification');
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'playerId', p2),
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'faabAmount', 5));
  v_trade_id := public.propose_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    '{}'::uuid[], ARRAY[p2], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);
  PERFORM public.withdraw_trade_atomic(v_trade_id, f.member_ids[1], f.user_ids[1]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'withdrawn' FROM public.trades WHERE id = v_trade_id)
    AND (SELECT jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0),
    'a withdrawal releases the hold');
END $$;

DO $$
DECLARE
  f record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  v_trade_id uuid;
  items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9709);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Reject', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[p1, p2, p3, p4]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p2, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p3, 'verification');
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'playerId', p2),
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'faabAmount', 5));
  v_trade_id := public.propose_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    '{}'::uuid[], ARRAY[p2], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);
  PERFORM public.reject_trade_atomic(v_trade_id, f.member_ids[2], f.user_ids[2]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'rejected' FROM public.trades WHERE id = v_trade_id)
    AND (SELECT jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0),
    'a rejection releases the hold');
END $$;

DO $$
DECLARE
  f record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  v_trade_id uuid;
  items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9710);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Retract', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[p1, p2, p3, p4]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p2, 'verification'),
           (f.league_id, f.season_id, f.member_ids[2], p3, 'verification');
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'playerId', p2),
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'faabAmount', 5));
  v_trade_id := public.propose_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    '{}'::uuid[], ARRAY[p2], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);
  PERFORM public.retract_trade_acceptance_atomic(v_trade_id, f.member_ids[1], f.user_ids[1]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'pending' FROM public.trades WHERE id = v_trade_id)
    AND (SELECT accepted_at IS NULL FROM public.trade_participants
      WHERE trade_participants.trade_id = v_trade_id AND member_id = f.member_ids[1])
    AND (SELECT jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0),
    'a proposer retraction releases the hold and keeps the trade pending');
  PERFORM public.accept_trade_atomic(v_trade_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(
    (SELECT accepted_at IS NOT NULL FROM public.trade_participants
      WHERE trade_participants.trade_id = v_trade_id AND member_id = f.member_ids[1]),
    'the proposer can accept again after retracting');
END $$;

DO $$
DECLARE
  f record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  p5 uuid := gen_random_uuid();
  v_trade_id uuid;
  items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9711);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 1, taxi_slots = 1,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, career_regular_season_games)
    VALUES (p1, 'Neighbor', 'One', 'PG', ARRAY['PG'], 'Healthy', 0),
           (p2, 'Neighbor', 'Two', 'PG', ARRAY['PG'], 'Healthy', 0),
           (p3, 'Neighbor', 'Three', 'PG', ARRAY['PG'], 'Healthy', 0),
           (p4, 'Neighbor', 'Four', 'PG', ARRAY['PG'], 'Healthy', 0),
           (p5, 'Neighbor', 'Five', 'PG', ARRAY['PG'], 'Healthy', 0);
  PERFORM private.authorize_taxi_acquisition(f.league_id, f.season_id, f.member_ids[1], p5, 'waiver', p5);
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_taxi)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification', false),
           (f.league_id, f.season_id, f.member_ids[1], p2, 'verification', false),
           (f.league_id, f.season_id, f.member_ids[1], p5, 'verification', true),
           (f.league_id, f.season_id, f.member_ids[2], p3, 'verification', false),
           (f.league_id, f.season_id, f.member_ids[2], p4, 'verification', false);
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', f.user_ids[1], 'role', 'authenticated')::text, true);
  PERFORM pg_temp.reject_rules(
    format('SELECT public.toggle_taxi_atomic(%L,false,%L)',
      (SELECT id FROM public.roster_players WHERE league_id = f.league_id AND player_id = p5), f.user_ids[1]),
    '%Your active roster is full (2 players).%',
    'the plain roster limit still rejects a full-roster taxi return');
  PERFORM pg_temp.reject_rules(
    format('SELECT public.toggle_ir_atomic(%L,true,%L)',
      (SELECT id FROM public.roster_players WHERE league_id = f.league_id AND player_id = p1), f.user_ids[1]),
    '%Only players with Out or IR designations can be placed on IR.%',
    'IR eligibility is unchanged');
  PERFORM pg_temp.reject_rules(
    format('SELECT public.toggle_taxi_atomic(%L,true,%L)',
      (SELECT id FROM public.roster_players WHERE league_id = f.league_id AND player_id = p1), f.user_ids[1]),
    '%Players enter taxi through a draft, trade, free-agent add or waiver claim.%',
    'taxi eligibility is unchanged');
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

DO $$
DECLARE
  f record;
  v_players uuid[];
  trade_a uuid;
  trade_b uuid;
  items jsonb;
  v_conflict jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(4, 9712);
  UPDATE public.leagues
     SET roster_size = 20, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  SELECT array_agg(gen_random_uuid()) INTO v_players FROM generate_series(1, 30);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Perspective', id::text, 'PG', ARRAY['PG'] FROM unnest(v_players) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[1], id, 'verification' FROM unnest(v_players[1:19]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[2], id, 'verification' FROM unnest(v_players[20:21]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[3], id, 'verification' FROM unnest(v_players[22:23]) id;
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'playerId', v_players[20]),
    jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[2], 'playerId', v_players[22]),
    jsonb_build_object('fromMemberId', f.member_ids[4], 'toMemberId', f.member_ids[3], 'faabAmount', 5));
  trade_a := public.propose_multi_team_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], ARRAY[f.member_ids[2], f.member_ids[3], f.member_ids[4]], items);
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[1], 'playerId', v_players[23]),
    jsonb_build_object('fromMemberId', f.member_ids[4], 'toMemberId', f.member_ids[3], 'faabAmount', 5));
  trade_b := public.propose_multi_team_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], ARRAY[f.member_ids[3], f.member_ids[4]], items);
  PERFORM public.accept_trade_atomic(trade_b, f.member_ids[4]);
  PERFORM pg_temp.reject_rules(
    format('SELECT public.accept_trade_atomic(%L,%L)', trade_b, f.member_ids[3]),
    '%needs the roster spot this trade would use%',
    'another team''s hold names the holder and its partners from the actor''s point of view');
  SELECT private.trade_hold_conflicts(
    f.league_id, f.season_id, f.member_ids[1], NULL, 'add', trade_b, true, f.member_ids[3], NULL)
    INTO v_conflict;
  PERFORM pg_temp.check_rules(
    (v_conflict->0->>'holderTeamName') = 'Rules team 1'
    AND (v_conflict->0->'partnerTeamNames') = '["Rules team 2", "Rules team 3", "Rules team 4"]'::jsonb
    AND (v_conflict->0->>'canWithdraw')::boolean = true,
    'the conflict names the holder and its partners');
  PERFORM pg_temp.check_rules(
    (v_conflict->0->>'message') = 'Rules team 1''s accepted trade with Rules team 2, Rules team 3 and Rules team 4 needs the roster spot this trade would use. Rules team 1 has to make room or withdraw that acceptance first.',
    'the actor-perspective message names the holder and its partners');
  PERFORM pg_temp.check_rules(
    (SELECT accepted_at IS NULL FROM public.trade_participants
      WHERE trade_id = trade_b AND member_id = f.member_ids[3]),
    'the blocked acceptance leaves the actor unaccepted');
END $$;

DO $$
DECLARE
  f record;
  v_players uuid[];
  trade_id uuid;
  v_drop_id uuid;
  v_roster_before int;
  v_roster_after int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9713);
  UPDATE public.leagues
     SET roster_size = 20, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  SELECT array_agg(gen_random_uuid()) INTO v_players FROM generate_series(1, 25);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Shrink', id::text, 'PG', ARRAY['PG'] FROM unnest(v_players) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[1], id, 'verification' FROM unnest(v_players[1:19]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[2], id, 'verification' FROM unnest(v_players[20:21]) id;
  trade_id := public.propose_trade_atomic(
    f.league_id, f.season_id, f.member_ids[2], f.member_ids[1],
    ARRAY[v_players[20]], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 0, 5);
  PERFORM public.accept_trade_atomic(trade_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'accepted' FROM public.trades WHERE id = trade_id),
    'the trade is accepted in the review window');
  PERFORM set_config('pancake.trade_hold_baseline', '', true);
  UPDATE public.leagues SET roster_size = 17 WHERE id = f.league_id;
  PERFORM pg_temp.check_rules(
    (SELECT jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 1),
    'the hold is already over the lowered limit');
  v_roster_before := (SELECT count(*) FROM public.roster_players
    WHERE league_id = f.league_id AND member_id = f.member_ids[1]);
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', f.user_ids[1], 'role', 'authenticated')::text, true);
  v_drop_id := (SELECT id FROM public.roster_players
    WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = v_players[1]);
  PERFORM public.drop_player_atomic(v_drop_id);
  v_roster_after := (SELECT count(*) FROM public.roster_players
    WHERE league_id = f.league_id AND member_id = f.member_ids[1]);
  PERFORM pg_temp.check_rules(
    v_roster_after = v_roster_before - 1,
    'a drop is allowed while a hold is already over the limit');
  PERFORM public.drop_player_atomic((SELECT id FROM public.roster_players
    WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = v_players[2]));
  PERFORM public.drop_player_atomic((SELECT id FROM public.roster_players
    WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = v_players[3]));
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM pg_temp.reject_immediate(
    format('INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(%L,%L,%L,%L,''verification'')',
      f.league_id, f.season_id, f.member_ids[1], v_players[22]),
    '%needs this roster spot%',
    'a growing write is still rejected while the hold is over the limit');
  PERFORM public.complete_accepted_trade_atomic(trade_id);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'completed' FROM public.trades WHERE id = trade_id)
    AND (SELECT count(*) FROM public.roster_players
      WHERE league_id = f.league_id AND member_id = f.member_ids[1]) = 17,
    'trade completion still works while the hold is over the limit');
END $$;


DO $$
DECLARE
  f record;
  x uuid := gen_random_uuid(); y uuid := gen_random_uuid(); z uuid := gen_random_uuid();
  u uuid := gen_random_uuid(); v uuid := gen_random_uuid();
  t1 uuid; t2 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9821);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Shared', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[x,y,z,u,v]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via) VALUES
    (f.league_id, f.season_id, f.member_ids[1], x, 'verification'),
    (f.league_id, f.season_id, f.member_ids[2], y, 'verification'),
    (f.league_id, f.season_id, f.member_ids[2], z, 'verification'),
    (f.league_id, f.season_id, f.member_ids[3], u, 'verification'),
    (f.league_id, f.season_id, f.member_ids[3], v, 'verification');
  t1 := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    ARRAY[x], ARRAY[y,z], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 0, 0);
  t2 := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[3],
    ARRAY[x], ARRAY[u,v], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 0, 0);
  PERFORM public.accept_trade_atomic(t1, f.member_ids[2]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'accepted' FROM public.trades WHERE id = t1)
    AND (SELECT status = 'withdrawn' FROM public.trades WHERE id = t2)
    AND (SELECT completion_failure_reason = 'A player in this offer was traded' FROM public.trades WHERE id = t2),
    'a final yes withdraws the pending offer that shares the moved player');
  PERFORM public.complete_accepted_trade_atomic(t1);
  PERFORM pg_temp.check_rules(
    (SELECT count(*) FROM public.roster_players WHERE league_id = f.league_id AND member_id = f.member_ids[1]) = 2
    AND (SELECT count(*) FROM public.roster_players WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id IN (y,z)) = 2,
    'the shared-asset final yes leaves the incoming players on the roster');
  PERFORM pg_temp.check_rules(
    jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0,
    'the shared-asset final yes leaves no hold conflict');
END $$;

DO $$
DECLARE
  f record;
  x uuid := gen_random_uuid(); w uuid := gen_random_uuid();
  y uuid := gen_random_uuid(); z uuid := gen_random_uuid();
  u uuid := gen_random_uuid(); v uuid := gen_random_uuid();
  t1 uuid; t2 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9822);
  UPDATE public.leagues
     SET roster_size = 3, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Distinct', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[x,w,y,z,u,v]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via) VALUES
    (f.league_id, f.season_id, f.member_ids[1], x, 'verification'),
    (f.league_id, f.season_id, f.member_ids[1], w, 'verification'),
    (f.league_id, f.season_id, f.member_ids[2], y, 'verification'),
    (f.league_id, f.season_id, f.member_ids[2], z, 'verification'),
    (f.league_id, f.season_id, f.member_ids[3], u, 'verification'),
    (f.league_id, f.season_id, f.member_ids[3], v, 'verification');
  t1 := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    ARRAY[x], ARRAY[y,z], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 0, 0);
  t2 := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[3],
    ARRAY[w], ARRAY[u,v], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 0, 0);
  PERFORM pg_temp.reject_rules(
    format('SELECT public.accept_trade_atomic(%L,%L)', t1, f.member_ids[2]),
    '%needs the roster spot this trade would use%',
    'a distinct-asset pending offer still blocks the final yes');
  PERFORM pg_temp.check_rules(
    (SELECT status = 'pending' FROM public.trades WHERE id = t1)
    AND (SELECT status = 'pending' FROM public.trades WHERE id = t2)
    AND (SELECT accepted_at IS NULL FROM public.trade_participants WHERE trade_id = t1 AND member_id = f.member_ids[2]),
    'the blocked distinct-asset final yes preserves state');
END $$;

DO $$
DECLARE
  f record;
  a1 uuid := gen_random_uuid(); b1 uuid := gen_random_uuid(); c1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid();
  t_acc uuid; t_new uuid;
  v_state text; v_detail text; v_msg text;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9823);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'member_vote', trade_veto_window_hours = 24,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Mask', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[a1,b1,c1,b2]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via) VALUES
    (f.league_id, f.season_id, f.member_ids[1], a1, 'verification'),
    (f.league_id, f.season_id, f.member_ids[2], b1, 'verification'),
    (f.league_id, f.season_id, f.member_ids[2], b2, 'verification'),
    (f.league_id, f.season_id, f.member_ids[3], c1, 'verification');
  t_acc := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[2], f.member_ids[1],
    ARRAY[b1], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 0, 1);
  PERFORM public.accept_trade_atomic(t_acc, f.member_ids[1]);
  t_new := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[3], f.member_ids[1],
    ARRAY[c1], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 0, 1);
  BEGIN
    PERFORM public.accept_trade_atomic(t_new, f.member_ids[1]);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL, v_msg = MESSAGE_TEXT;
  END;
  PERFORM pg_temp.check_rules(
    v_state = 'PT409'
    AND (v_detail::jsonb->>'code') = 'roster_hold'
    AND v_msg LIKE '%Your accepted trade with Rules team 2 needs this roster spot%',
    'the acceptance raises the named roster hold instead of the reserved-capacity message');
END $$;

DO $$
DECLARE
  f record;
  a1 uuid := gen_random_uuid(); c1 uuid := gen_random_uuid(); d1 uuid := gen_random_uuid();
  t_new uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9824);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Own', id::text, 'PG', ARRAY['PG'] FROM unnest(ARRAY[a1,c1,d1]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via) VALUES
    (f.league_id, f.season_id, f.member_ids[1], a1, 'verification'),
    (f.league_id, f.season_id, f.member_ids[2], c1, 'verification'),
    (f.league_id, f.season_id, f.member_ids[2], d1, 'verification');
  t_new := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[2], f.member_ids[1],
    ARRAY[c1,d1], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 0, 1);
  PERFORM pg_temp.reject_rules(
    format('SELECT public.accept_trade_atomic(%L,%L)', t_new, f.member_ids[1]),
    '%is 1 over the limit of 2%',
    'a trade that overflows a roster on its own keeps the over-the-limit message');
END $$;

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
