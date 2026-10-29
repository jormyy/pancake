BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  v_players uuid[];
  injured uuid;
  active uuid;
  claim uuid;
  allow_inactive boolean;
  compound boolean;
  recovered boolean;
BEGIN
  FOREACH allow_inactive IN ARRAY ARRAY[false, true] LOOP
    FOREACH compound IN ARRAY ARRAY[false, true] LOOP
      FOREACH recovered IN ARRAY ARRAY[false, true] LOOP
        SELECT * INTO f FROM pg_temp.rules_fixture(2, 9387);
        v_players := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
        UPDATE public.leagues SET roster_size = 1, allow_inactive_trades = allow_inactive WHERE id = f.league_id;
        INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status)
        SELECT id, 'Recovered', id::text, 'PG', ARRAY['PG'], 'Out' FROM unnest(v_players) id;
        INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, is_on_ir, acquired_via)
        VALUES(f.league_id, f.season_id, f.member_ids[1], v_players[1], true, 'draft') RETURNING id INTO injured;
        INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
        VALUES(f.league_id, f.season_id, f.member_ids[1], v_players[2], 'draft') RETURNING id INTO active;
        INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id)
        VALUES(f.league_id, f.season_id, v_players[3]);
        claim := public.create_waiver_claim_atomic(f.league_id, f.member_ids[1], v_players[3], v_players[2], f.user_ids[1]);
        IF recovered THEN UPDATE public.players SET injury_status = NULL WHERE id = v_players[1]; END IF;
        PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
        IF compound THEN
          PERFORM pg_temp.reject_rules(format('SELECT public.activate_roster_player_with_overflow_atomic(%L,%L,%L,%L)',injured,'ir',active,'drop'),'%Locked by waiver claim%','a pending claim blocks compound drops '||f.league_id);
        ELSE
          PERFORM pg_temp.reject_rules(format('SELECT public.drop_player_atomic(%L)',active),'%Locked by waiver claim%','a pending claim blocks ordinary drops '||f.league_id);
        END IF;
        PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.waiver_claims WHERE id=claim AND status='pending' AND drop_player_id=v_players[2]),'a rejected drop preserves its pending claim '||f.league_id);
        PERFORM public.cancel_waiver_claim_atomic(claim,f.member_ids[1],f.user_ids[1]);
        IF compound THEN
          PERFORM public.activate_roster_player_with_overflow_atomic(injured,'ir',active,'drop');
        ELSE
          PERFORM public.drop_player_atomic(active);
        END IF;
        PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.roster_players WHERE id=active),'cancelling the claim releases its drop player '||f.league_id);
        PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.notification_outbox
          WHERE dedupe_key = 'trade_claim_cancelled:' || claim),
          'ordinary drop sends no cancellation with inactive trades ' || allow_inactive || ' and activation ' || compound || ' and recovered ' || recovered);
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
