BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  scenario record;
  player uuid;
  claim uuid;
  clearance timestamptz;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9393);
  FOR scenario IN SELECT * FROM (VALUES
    ('exact run', '2026-01-01 08:00:00+00'::timestamptz, '2026-01-03 08:00:00+00'::timestamptz),
    ('after run', '2026-01-01 08:00:00.001+00'::timestamptz, '2026-01-04 08:00:00+00'::timestamptz),
    ('midday', '2026-01-01 17:00:00+00'::timestamptz, '2026-01-04 08:00:00+00'::timestamptz),
    ('spring clock change', '2026-03-06 08:00:00+00'::timestamptz, '2026-03-09 07:00:00+00'::timestamptz),
    ('fall clock change', '2026-10-30 07:00:00+00'::timestamptz, '2026-11-01 08:00:00+00'::timestamptz),
    ('claim run', '1900-01-01 12:00:00+00'::timestamptz, '1900-01-04 08:00:00+00'::timestamptz)
  ) cases(label, placed_at, expected_at) LOOP
    player := gen_random_uuid();
    INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    VALUES(player, 'Clearance', scenario.label, 'PG', ARRAY['PG']);
    INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, placed_on_waivers_at)
    VALUES(f.league_id, f.season_id, player, scenario.placed_at) RETURNING clears_at INTO clearance;
    PERFORM pg_temp.check_rules(clearance = scenario.expected_at, 'clearance uses the first eligible ET run: ' || scenario.label);
    IF scenario.label = 'claim run' THEN
      claim := public.create_waiver_claim_atomic(f.league_id, f.member_ids[1], player, NULL, f.user_ids[1]);
      PERFORM pg_temp.check_rules((SELECT (process_date + time '03:00') AT TIME ZONE 'America/New_York' > now() FROM public.waiver_claims WHERE id = claim),
        'new claims use a future run even after an old hold');
      UPDATE public.waiver_claims SET process_date='1900-01-04' WHERE id=claim;
      PERFORM public.process_due_waiver_claims_atomic(p_process_date := '1900-01-04', p_limit := 100);
      PERFORM pg_temp.check_rules((SELECT status = 'succeeded' FROM public.waiver_claims WHERE id = claim),
        'the claim succeeds during its scheduled clearance run');
      PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.waiver_wire_log
        WHERE league_id = f.league_id AND player_id = player AND cleared_at IS NOT NULL),
        'the run clears its scheduled waiver entry');
    END IF;
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
