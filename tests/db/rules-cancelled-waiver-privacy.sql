BEGIN;
\ir rules-support.sql

CREATE TEMP TABLE rules_claim_fixture AS SELECT * FROM pg_temp.rules_fixture(2, 9373);
GRANT SELECT ON rules_claim_fixture TO authenticated;

INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
VALUES('00000000-0000-4000-8000-000000937301', 'Privacy', 'Claim', 'PG', ARRAY['PG']);
INSERT INTO public.waiver_claims(league_id, league_season_id, member_id, player_id, status, process_date, priority_at_submission)
SELECT fixture.league_id, fixture.season_id, fixture.member_ids[1], '00000000-0000-4000-8000-000000937301',
  value::public.waiver_claim_status, current_date, 1
FROM rules_claim_fixture fixture CROSS JOIN unnest(ARRAY['pending', 'cancelled', 'succeeded', 'failed_priority']) value;

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_fixture record;
  v_index int;
BEGIN
  SELECT * INTO v_fixture FROM rules_claim_fixture;
  FOR v_index IN 1..2 LOOP
    PERFORM set_config('request.jwt.claim.sub', v_fixture.user_ids[v_index]::text, true);
    PERFORM pg_temp.check_rules((SELECT count(*) = CASE WHEN v_index = 1 THEN 2 ELSE 0 END
      FROM public.waiver_claims WHERE league_id = v_fixture.league_id AND status IN ('pending', 'cancelled')),
      'pending and cancelled claims stay private for member ' || v_index);
    PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM public.waiver_claims
      WHERE league_id = v_fixture.league_id AND status IN ('succeeded', 'failed_priority')),
      'processed claims remain visible for member ' || v_index);
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  PERFORM pg_temp.check_rules((SELECT count(*) = 0 FROM public.waiver_claims WHERE league_id = v_fixture.league_id),
    'outsider cannot read claim history');
END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
