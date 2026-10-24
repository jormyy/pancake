BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  players uuid[];
  offer uuid;
  claim uuid;
  allow_inactive boolean;
BEGIN
  FOREACH allow_inactive IN ARRAY ARRAY[false, true] LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(2, 9389);
    players := ARRAY[gen_random_uuid(), gen_random_uuid()];
    UPDATE public.leagues SET allow_inactive_trades = allow_inactive WHERE id = f.league_id;
    INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Legacy', id::text, 'PG', ARRAY['PG'] FROM unnest(players) id;
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[1], players[1], 'draft');
    INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, placed_on_waivers_at)
    VALUES(f.league_id, f.season_id, players[2], '1900-01-01 12:00+00');
    claim := public.create_waiver_claim_atomic(f.league_id, f.member_ids[1], players[2], players[1], f.user_ids[1]);
    offer := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
      ARRAY[players[1]], '{}', '{}', '{}', NULL, NULL, 0, 1);
    PERFORM public.accept_trade_atomic(offer, f.member_ids[2]);
    UPDATE public.trades SET veto_window_expires_at = now() - interval '1 minute' WHERE id = offer;
    PERFORM public.complete_accepted_trade_atomic(offer);
    PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.waiver_claims WHERE id = claim AND drop_player_id IS NULL
      AND status = CASE WHEN allow_inactive THEN 'cancelled'::public.waiver_claim_status ELSE 'pending'::public.waiver_claim_status END
      AND (processed_at IS NOT NULL) = allow_inactive AND (failure_reason IS NOT NULL) = allow_inactive),
      'claim retention follows inactive trade setting ' || allow_inactive);
    PERFORM pg_temp.check_rules((SELECT count(*) = CASE WHEN allow_inactive THEN 1 ELSE 0 END
      FROM public.notification_outbox WHERE dedupe_key = 'trade_claim_cancelled:' || claim),
      'only cancelled claims notify with inactive trades ' || allow_inactive);
    IF NOT allow_inactive THEN
      UPDATE public.waiver_claims SET process_date = '1900-01-04' WHERE id = claim;
      PERFORM public.process_next_waiver_claim_atomic('1900-01-04');
      PERFORM pg_temp.check_rules((SELECT status = 'succeeded' FROM public.waiver_claims WHERE id = claim),
        'a retained legacy claim succeeds without the traded drop');
    END IF;
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
