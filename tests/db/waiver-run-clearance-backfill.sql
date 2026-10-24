BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE clearance_fixture AS SELECT * FROM pg_temp.rules_fixture(2, 9394);
CREATE TEMP TABLE clearance_entries AS
SELECT gen_random_uuid() AS player_id, cleared FROM (VALUES(false), (true)) states(cleared);
INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
SELECT player_id, 'Backfill', cleared::text, 'PG', ARRAY['PG'] FROM clearance_entries;
INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, placed_on_waivers_at, cleared_at)
SELECT fixture.league_id, fixture.season_id, entry.player_id, '1900-01-01 12:00+00'::timestamptz,
  CASE WHEN entry.cleared THEN '1900-01-04 08:00+00'::timestamptz END
FROM clearance_fixture fixture CROSS JOIN clearance_entries entry;
UPDATE public.waiver_wire_log SET clears_at = placed_on_waivers_at + interval '48 hours'
WHERE league_id = (SELECT league_id FROM clearance_fixture);
CREATE TEMP TABLE clearance_claim AS
SELECT public.create_waiver_claim_atomic(f.league_id, f.member_ids[1], entry.player_id, NULL, f.user_ids[1]) AS id
FROM clearance_fixture f CROSS JOIN clearance_entries entry WHERE NOT entry.cleared;

\if :{?waiver_clearance_migration}
\i :waiver_clearance_migration
\else
\ir ../../supabase/migrations/20261026000035_waiver_run_clearance.sql
\endif

SELECT pg_temp.check_rules((SELECT clears_at = '1900-01-04 08:00+00'::timestamptz
  FROM public.waiver_wire_log WHERE player_id = (SELECT player_id FROM clearance_entries WHERE NOT cleared)),
  'the migration reschedules uncleared legacy entries');
SELECT pg_temp.check_rules((SELECT clears_at = '1900-01-03 12:00+00'::timestamptz
  FROM public.waiver_wire_log WHERE player_id = (SELECT player_id FROM clearance_entries WHERE cleared)),
  'the migration preserves processed waiver history');
SELECT count(*) FROM public.process_due_waiver_claims_atomic(p_process_date := '1900-01-04', p_limit := 100);
SELECT pg_temp.check_rules((SELECT status = 'succeeded' FROM public.waiver_claims
  WHERE id = (SELECT id FROM clearance_claim)), 'existing claims process in the rescheduled run');
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
