BEGIN;
\ir rules-support.sql
SELECT pg_temp.check_rules(private.next_waiver_run(NULL,'2026-03-08 06:59:59+00')='2026-03-08 07:00:00+00'::timestamptz,'spring transition runs at 3 AM Eastern');
SELECT pg_temp.check_rules(private.next_waiver_run(NULL,'2026-11-01 07:59:59+00')='2026-11-01 08:00:00+00'::timestamptz,'fall transition runs at 3 AM Eastern');
SELECT pg_temp.check_rules(private.next_waiver_run(NULL,'2026-03-08 07:00:00+00')='2026-03-09 07:00:00+00'::timestamptz,'cutoff instant goes to next run');
SELECT pg_temp.check_rules(private.next_waiver_run('2026-03-09 07:00:00+00','2026-03-07 12:00:00+00')='2026-03-09 07:00:00+00'::timestamptz,'hold ending at run is eligible');
SELECT pg_temp.check_rules(private.next_waiver_run('2026-03-09 07:00:01+00','2026-03-07 12:00:00+00')='2026-03-10 07:00:00+00'::timestamptz,'hold ending after run waits');
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
