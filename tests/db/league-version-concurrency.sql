\set ON_ERROR_STOP on
\getenv version_db_port PANCAKE_TEST_DB_PORT
\if :{?version_db_port}
\else
  \set version_db_port 59122
\endif
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT'=:'version_db_port' AS version_local \gset
\if :version_local
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the private loopback version test database.'; END $$;
\endif
BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE version_concurrency_fixture AS SELECT * FROM pg_temp.rules_fixture(3,9564);
COMMIT;
SELECT league_id AS probe_league,member_ids[2] AS probe_member_one,member_ids[3] AS probe_member_two
  FROM version_concurrency_fixture \gset
\setenv VERSION_PROBE_LEAGUE :probe_league
\setenv VERSION_PROBE_MEMBER_ONE :probe_member_one
\setenv VERSION_PROBE_MEMBER_TWO :probe_member_two
CREATE TEMP TABLE version_before AS SELECT version FROM public.league_versions WHERE league_id=:'probe_league';
\! psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -c "BEGIN; SELECT version FROM public.league_versions WHERE league_id='$VERSION_PROBE_LEAGUE' FOR UPDATE; SELECT pg_sleep(2); COMMIT;" & version_lock_pid=$!; sleep 0.3; psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -c "BEGIN; DELETE FROM public.waiver_priorities WHERE member_id='$VERSION_PROBE_MEMBER_ONE'; DELETE FROM public.faab_balances WHERE member_id='$VERSION_PROBE_MEMBER_ONE'; DELETE FROM public.league_members WHERE id='$VERSION_PROBE_MEMBER_ONE'; COMMIT;" & version_first_pid=$!; psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -c "BEGIN; DELETE FROM public.waiver_priorities WHERE member_id='$VERSION_PROBE_MEMBER_TWO'; DELETE FROM public.faab_balances WHERE member_id='$VERSION_PROBE_MEMBER_TWO'; DELETE FROM public.league_members WHERE id='$VERSION_PROBE_MEMBER_TWO'; COMMIT;" & version_second_pid=$!; wait "$version_lock_pid"; wait "$version_first_pid"; wait "$version_second_pid"
DO $$
DECLARE f record; stored public.league_versions%ROWTYPE;
BEGIN
  SELECT * INTO f FROM version_concurrency_fixture;
  SELECT * INTO stored FROM public.league_versions WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(stored.version=(SELECT version+2 FROM version_before),'two concurrent commits produce exactly two bumps');
  PERFORM pg_temp.check_rules(stored.reader_ids=ARRAY[f.user_ids[1]],'concurrent removals never restore cached access');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM public.league_changes WHERE league_id=f.league_id AND version>(SELECT version FROM version_before)),'concurrent versions have exactly one log entry each');
  PERFORM pg_temp.check_rules((SELECT revision=stored.version FROM public.league_change_hints WHERE league_id=f.league_id AND topic='version'),'last realtime event carries the last committed version');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
BEGIN;
DELETE FROM public.leagues WHERE id=(SELECT league_id FROM version_concurrency_fixture);
DELETE FROM auth.users WHERE id=ANY((SELECT user_ids FROM version_concurrency_fixture)::uuid[]);
COMMIT;
