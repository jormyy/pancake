BEGIN;
\ir rules-support.sql

DO $$
DECLARE
  f record;
  players uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  held uuid;
  pending uuid;
  multi uuid;
  claim uuid;
  affordable uuid;
  items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9382);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
  SELECT id, 'Reserved', id::text, 'PG', ARRAY['PG'] FROM unnest(players) id;
  INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, placed_on_waivers_at)
  SELECT f.league_id, f.season_id, id, '1900-01-01 12:00+00'::timestamptz FROM unnest(players) id;
  claim := public.create_waiver_claim_atomic(f.league_id, f.member_ids[1], players[1], NULL, f.user_ids[1], 50, 1);
  pending := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[3],
    '{}', '{}', '{}', '{}', NULL, NULL, 80, 1);
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[3], 'faabAmount', 80),
    jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[2], 'faabAmount', 1));
  multi := public.propose_multi_team_trade_atomic(f.league_id, f.season_id, f.member_ids[1],
    ARRAY[f.member_ids[2], f.member_ids[3]], items);
  held := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[2], f.member_ids[1],
    '{}', '{}', '{}', '{}', NULL, NULL, 1, 80);
  PERFORM public.accept_trade_atomic(held, f.member_ids[1]);

  PERFORM pg_temp.reject_rules(format('SELECT public.propose_trade_atomic(%L,%L,%L,%L,%L,%L,%L,%L,NULL,NULL,81,1)',
    f.league_id, f.season_id, f.member_ids[1], f.member_ids[3], '{}', '{}', '{}', '{}'),
    '%available balance%', 'a new offer cannot spend accepted FAAB');
  PERFORM pg_temp.reject_rules(format('SELECT public.propose_trade_atomic(%L,%L,%L,%L,%L,%L,%L,%L,NULL,NULL,1,81)',
    f.league_id, f.season_id, f.member_ids[3], f.member_ids[1], '{}', '{}', '{}', '{}'),
    '%available balance%', 'a requested amount cannot spend accepted FAAB');
  PERFORM pg_temp.reject_rules(format('SELECT public.propose_multi_team_trade_atomic(%L,%L,%L,%L,%L)',
    f.league_id, f.season_id, f.member_ids[1], ARRAY[f.member_ids[2], f.member_ids[3]], jsonb_set(items,'{0,faabAmount}','81')),
    '%available balance%', 'a multi-team offer cannot spend accepted FAAB');
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)', pending, f.member_ids[3]),
    '%budget is short%', 'an older offer cannot accept reserved FAAB');
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)', multi, f.member_ids[3]),
    '%budget is short%', 'a multi-team acceptance checks all senders');
  PERFORM pg_temp.reject_rules(format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,NULL,%L,50,1)',
    f.league_id, f.member_ids[1], players[2], f.user_ids[1]),
    '%FAAB%', 'a new claim cannot spend reserved FAAB');
  PERFORM pg_temp.reject_rules(format('SELECT public.edit_waiver_claim_atomic(%L,%L,%L,NULL,50,1)',
    claim, f.member_ids[1], f.user_ids[1]), '%FAAB%', 'claim edits cannot spend reserved FAAB');
  PERFORM pg_temp.check_rules(private.available_faab_balance(f.league_id, f.season_id, f.member_ids[1]) = 20,
    'accepted outgoing dollars reduce available FAAB');
  PERFORM pg_temp.check_rules(private.available_faab_balance(f.league_id, f.season_id, f.member_ids[1], held) = 100,
    'the current trade can exclude its own reservation');

  UPDATE public.waiver_claims SET process_date = '1900-01-04' WHERE id = claim;
  PERFORM public.process_next_waiver_claim_atomic('1900-01-04');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.waiver_claims WHERE id = claim
    AND status = 'failed_priority' AND failure_reason = 'Insufficient FAAB budget for this bid.'),
    'queued bids fail through the existing insufficient FAAB path');
  affordable := public.create_waiver_claim_atomic(f.league_id, f.member_ids[1], players[2], NULL, f.user_ids[1], 20, 1);
  UPDATE public.waiver_claims SET process_date = '1900-01-04' WHERE id = affordable;
  PERFORM public.process_next_waiver_claim_atomic('1900-01-04');
  PERFORM pg_temp.check_rules((SELECT status = 'succeeded' FROM public.waiver_claims WHERE id = affordable),
    'unreserved FAAB remains spendable');
  UPDATE public.trades SET veto_window_expires_at = now() - interval '1 minute' WHERE id = held;
  PERFORM public.complete_accepted_trade_atomic(held);
  PERFORM pg_temp.check_rules((SELECT status = 'completed' FROM public.trades WHERE id = held),
    'settlement uses the raw balance without double-counting its reservation');
  PERFORM pg_temp.check_rules(private.available_faab_balance(f.league_id, f.season_id, f.member_ids[1]) = 1,
    'completion releases the reservation and transfers the committed FAAB');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
