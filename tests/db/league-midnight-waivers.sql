\set ON_ERROR_STOP on
\set expected_db_port 58022
\getenv expected_db_port PANCAKE_TEST_DB_PORT
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT' = :'expected_db_port' AS local_target \gset
\if :local_target
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the private local database.'; END $$;
\endif
BEGIN;
\ir rules-support.sql
DELETE FROM private.work_items;
DO $$
DECLARE
  fixture record;
  zone text;
  reference timestamptz;
  due timestamptz;
  actual timestamptz;
  previous_due timestamptz;
  player uuid;
  placed timestamptz;
  checks integer := 0;
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2, 9541, 'active');
  FOREACH zone IN ARRAY ARRAY['America/Los_Angeles', 'America/Chicago', 'Asia/Kolkata'] LOOP
    UPDATE public.leagues SET timezone=zone WHERE id=fixture.league_id;
    previous_due := NULL;
    FOREACH reference IN ARRAY ARRAY['2026-03-08 12:00Z'::timestamptz, '2026-03-09 12:00Z'::timestamptz,
      '2026-11-01 12:00Z'::timestamptz, '2026-11-02 12:00Z'::timestamptz] LOOP
      due := ((reference AT TIME ZONE zone)::date)::timestamp AT TIME ZONE zone;
      PERFORM private.enqueue_scheduled_work(reference);
      SELECT due_at INTO actual FROM private.work_items
        WHERE kind='process-waivers' AND key=zone || ':' || (reference AT TIME ZONE zone)::date::text;
      PERFORM pg_temp.check_rules(actual IS NOT NULL AND actual=due, zone || ' scheduled midnight ' || reference);
      PERFORM pg_temp.check_rules((actual AT TIME ZONE zone)::time=time '00:00', zone || ' local clock is midnight ' || reference);
      IF previous_due IS NOT NULL AND due-previous_due < interval '2 days' AND zone<>'Asia/Kolkata' THEN
        PERFORM pg_temp.check_rules(due-previous_due IN (interval '23 hours', interval '25 hours'), zone || ' DST day length ' || reference);
      END IF;
      previous_due := due;
      UPDATE private.work_items SET status='succeeded' WHERE kind='process-waivers';
      player := gen_random_uuid();
      INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,status,nba_team)
        VALUES(player,'Midnight','Fixture','PG',ARRAY['PG'],'Active','SIM');
      placed := due - interval '48 hours';
      INSERT INTO public.waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at)
        VALUES(fixture.league_id,fixture.season_id,player,placed) RETURNING clears_at INTO actual;
      PERFORM pg_temp.check_rules(actual=due AND actual-placed>=interval '48 hours', zone || ' drop hold ends at midnight ' || reference);
      checks := checks + 1;
    END LOOP;
  END LOOP;
  PERFORM pg_temp.check_rules(private.next_waiver_run('2026-03-08 08:00Z','2026-03-07 08:01Z')='2026-03-08 08:00Z', 'spring midnight before transition');
  PERFORM pg_temp.check_rules(private.next_waiver_run(NULL,'2026-03-08 08:00Z')='2026-03-09 07:00Z', 'spring midnight after transition');
  PERFORM pg_temp.check_rules(private.next_waiver_run(NULL,'2026-11-01 07:00Z')='2026-11-02 08:00Z', 'fall midnight after transition');
  RAISE NOTICE 'Verified % scheduled runs and drop holds across three timezones', checks;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
