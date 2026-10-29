BEGIN;
\ir rules-support.sql

CREATE FUNCTION pg_temp.reject_rules_trade_move()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_id IS DISTINCT FROM OLD.member_id
      AND NEW.player_id::text = current_setting('rules.reject_player', true) THEN
    RAISE EXCEPTION 'Destination changed before settlement.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rules_reject_trade_move BEFORE UPDATE ON public.roster_players
  FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_rules_trade_move();

DO $$
DECLARE
  v_fixture record;
  v_other record;
  v_players uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_trade uuid;
  v_other_trade uuid;
  v_claim uuid;
  v_result jsonb;
BEGIN
  SELECT * INTO v_fixture FROM pg_temp.rules_fixture(2, 9374);
  SELECT * INTO v_other FROM pg_temp.rules_fixture(2, 9374);
  UPDATE public.leagues SET allow_inactive_trades = true, ir_slots = 2 WHERE id = v_fixture.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, years_exp, injury_status)
  SELECT id, 'Trade', 'Reservation', 'PG', ARRAY['PG'], 3, 'Out' FROM unnest(v_players) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES(v_fixture.league_id, v_fixture.season_id, v_fixture.member_ids[1], v_players[1], 'draft'),
    (v_fixture.league_id, v_fixture.season_id, v_fixture.member_ids[1], v_players[3], 'draft');
  INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, clears_at)
  VALUES(v_fixture.league_id, v_fixture.season_id, v_players[2], now() + interval '48 hours');
  v_claim := public.create_waiver_claim_atomic(v_fixture.league_id, v_fixture.member_ids[1],
    v_players[2], v_players[1], v_fixture.user_ids[1]);
  SET CONSTRAINTS ALL IMMEDIATE;
  ALTER TABLE public.trade_items DISABLE TRIGGER guard_trade_item_plan_reservations;
  SET CONSTRAINTS ALL DEFERRED;
  v_trade := public.propose_trade_atomic(v_fixture.league_id, v_fixture.season_id,
    v_fixture.member_ids[1], v_fixture.member_ids[2], ARRAY[v_players[1]], '{}', '{}', '{}', NULL, NULL, 0, 1);
  PERFORM public.set_trade_roster_plan_atomic(v_trade, v_fixture.member_ids[2], v_fixture.user_ids[2], '{}', ARRAY[v_players[1]], '{}');
  SET CONSTRAINTS ALL IMMEDIATE;
  ALTER TABLE public.trade_items ENABLE TRIGGER guard_trade_item_plan_reservations;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM public.accept_trade_atomic(v_trade, v_fixture.member_ids[2]);
  UPDATE public.trades SET veto_window_expires_at = now() - interval '2 minutes' WHERE id = v_trade;
  v_other_trade := public.propose_trade_atomic(v_other.league_id, v_other.season_id,
    v_other.member_ids[1], v_other.member_ids[2], '{}', '{}', '{}', '{}', NULL, NULL, 1, 1);
  PERFORM public.accept_trade_atomic(v_other_trade, v_other.member_ids[2]);
  UPDATE public.trades SET veto_window_expires_at = now() - interval '1 minute' WHERE id = v_other_trade;
  SELECT jsonb_agg(to_jsonb(result)) INTO v_result FROM public.process_due_accepted_trades_atomic(200) result;
  PERFORM pg_temp.check_rules(v_result @> jsonb_build_array(jsonb_build_object('trade_id', v_trade, 'status', 'completed')),
    'pending waiver drop moves to receiving IR');
  PERFORM pg_temp.check_rules(v_result @> jsonb_build_array(jsonb_build_object('trade_id', v_other_trade, 'status', 'completed')),
    'another league settles in the same batch');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.roster_players WHERE league_season_id = v_fixture.season_id
    AND member_id = v_fixture.member_ids[2] AND player_id = v_players[1] AND is_on_ir), 'player reaches receiving IR');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.waiver_claims WHERE id = v_claim AND status = 'cancelled'
    AND drop_player_id IS NULL AND processed_at IS NOT NULL
    AND failure_reason = 'The selected drop player left this roster in another transaction.'), 'claim cancellation records the reason');
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM public.notification_outbox
    WHERE dedupe_key = 'trade_claim_cancelled:' || v_claim), 'cancelled claim notifies its owner once');

  v_claim := public.create_waiver_claim_atomic(v_fixture.league_id, v_fixture.member_ids[1],
    v_players[2], v_players[3], v_fixture.user_ids[1]);
  SET CONSTRAINTS ALL IMMEDIATE;
  ALTER TABLE public.trade_items DISABLE TRIGGER guard_trade_item_plan_reservations;
  SET CONSTRAINTS ALL DEFERRED;
  v_trade := public.propose_trade_atomic(v_fixture.league_id, v_fixture.season_id,
    v_fixture.member_ids[1], v_fixture.member_ids[2], ARRAY[v_players[3]], '{}', '{}', '{}', NULL, NULL, 0, 1);
  PERFORM public.set_trade_roster_plan_atomic(v_trade, v_fixture.member_ids[2], v_fixture.user_ids[2], '{}', ARRAY[v_players[3]], '{}');
  SET CONSTRAINTS ALL IMMEDIATE;
  ALTER TABLE public.trade_items ENABLE TRIGGER guard_trade_item_plan_reservations;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM public.accept_trade_atomic(v_trade, v_fixture.member_ids[2]);
  UPDATE public.trades SET veto_window_expires_at = now() - interval '2 minutes' WHERE id = v_trade;
  PERFORM set_config('rules.reject_player', v_players[3]::text, true);
  v_other_trade := public.propose_trade_atomic(v_other.league_id, v_other.season_id,
    v_other.member_ids[1], v_other.member_ids[2], '{}', '{}', '{}', '{}', NULL, NULL, 1, 1);
  PERFORM public.accept_trade_atomic(v_other_trade, v_other.member_ids[2]);
  UPDATE public.trades SET veto_window_expires_at = now() - interval '1 minute' WHERE id = v_other_trade;
  SELECT jsonb_agg(to_jsonb(result)) INTO v_result FROM public.process_due_accepted_trades_atomic(200) result;
  PERFORM pg_temp.check_rules(v_result @> jsonb_build_array(jsonb_build_object('trade_id', v_trade,
    'status', 'deferred', 'error_code', 'PT001')), 'non-taxi P0001 holds the trade for repair');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(v_result) result
    WHERE result->>'trade_id'=v_trade::text AND result->>'error_message' LIKE 'IR acquisition failed: Destination changed before settlement.%'),
    'IR terminal failure names its destination');
  PERFORM pg_temp.check_rules(v_result @> jsonb_build_array(jsonb_build_object('trade_id', v_other_trade, 'status', 'completed')),
    'a failed non-taxi destination does not abort another league');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.roster_players WHERE league_season_id = v_fixture.season_id
    AND member_id = v_fixture.member_ids[1] AND player_id = v_players[3]), 'failed settlement keeps the original owner');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.waiver_claims WHERE id = v_claim AND status = 'pending'
    AND drop_player_id = v_players[3]) AND NOT EXISTS(SELECT 1 FROM public.notification_outbox
      WHERE dedupe_key = 'trade_claim_cancelled:' || v_claim), 'failed settlement rolls back claim cancellation and notification');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
