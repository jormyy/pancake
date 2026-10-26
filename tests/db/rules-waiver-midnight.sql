BEGIN;
\ir rules-support.sql

DO $$
DECLARE
  v_fixture record;
  v_mode text;
  v_players uuid[];
  v_claim uuid;
  v_older_claim uuid;
  v_result record;
  v_process_date date := (now() AT TIME ZONE 'America/New_York')::date - 1;
BEGIN
  FOREACH v_mode IN ARRAY ARRAY['faab', 'rolling', 'preference'] LOOP
    SELECT * INTO v_fixture FROM pg_temp.rules_fixture(2, 9371);
    UPDATE public.leagues SET waiver_mode = CASE WHEN v_mode = 'faab' THEN 'faab' ELSE 'rolling' END,
      roster_size = 1 WHERE id = v_fixture.league_id;
    v_players := ARRAY[gen_random_uuid(), gen_random_uuid()];
    INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, years_exp)
    SELECT id, 'Midnight', 'Player', 'PG', ARRAY['PG'], 3 FROM unnest(v_players) id;
    INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, placed_on_waivers_at, clears_at)
    SELECT v_fixture.league_id, v_fixture.season_id, id, now() - interval '4 days', now() + interval '1 hour'
    FROM unnest(v_players) id;
    v_older_claim := public.create_waiver_claim_atomic(v_fixture.league_id, v_fixture.member_ids[CASE WHEN v_mode = 'preference' THEN 1 ELSE 2 END],
      v_players[1], NULL, v_fixture.user_ids[CASE WHEN v_mode = 'preference' THEN 1 ELSE 2 END],
      CASE WHEN v_mode = 'faab' THEN 1 ELSE 0 END, 1);
    v_claim := public.create_waiver_claim_atomic(v_fixture.league_id, v_fixture.member_ids[1],
      v_players[2], NULL, v_fixture.user_ids[1], CASE WHEN v_mode = 'faab' THEN 5 ELSE 0 END, 1);
    IF v_mode = 'preference' THEN
      UPDATE public.waiver_claims SET claim_order = CASE WHEN id = v_claim THEN 1 ELSE 2 END
      WHERE league_id = v_fixture.league_id;
    END IF;
    UPDATE public.waiver_claims SET process_date = CASE WHEN id = v_claim THEN v_process_date ELSE v_process_date - 1 END
    WHERE league_id = v_fixture.league_id;
    UPDATE public.waiver_wire_log SET clears_at =
      ((v_process_date - 1)::timestamp + CASE WHEN player_id = v_players[1] THEN interval '2 hours 59 minutes'
        ELSE interval '3 hours 1 minute' END) AT TIME ZONE 'America/New_York'
    WHERE league_id = v_fixture.league_id;
    SELECT * INTO v_result FROM public.process_next_waiver_claim_atomic(v_process_date);
    PERFORM pg_temp.check_rules(v_result.claim_id = v_older_claim AND v_result.status = 'succeeded',
      v_mode || ' processes the older due run before a newer preferred claim');
    PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.roster_players
      WHERE league_season_id = v_fixture.season_id AND member_id = v_fixture.member_ids[CASE WHEN v_mode = 'preference' THEN 1 ELSE 2 END] AND player_id = v_players[1]),
      v_mode || ' awards the older eligible player first');
    PERFORM pg_temp.check_rules((SELECT status = 'pending' FROM public.waiver_claims WHERE id = v_claim),
      v_mode || ' keeps the newer claim pending until the older run settles');
    SELECT * INTO v_result FROM public.process_next_waiver_claim_atomic(v_process_date);
    PERFORM pg_temp.check_rules(v_result.claim_id = v_claim,
      v_mode || ' resumes with the newer claim after settling the older run');
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
