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
CREATE TEMP TABLE version_read_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9563);
SET CONSTRAINTS private.league_version_commit IMMEDIATE;
DO $$
DECLARE f record; counter bigint; response jsonb;
BEGIN
  SELECT * INTO f FROM version_read_fixture;
  SELECT version INTO counter FROM public.league_versions WHERE league_id=f.league_id;
  ALTER TABLE public.league_changes RENAME TO version_hidden_changes;
  ALTER TABLE public.league_members RENAME TO version_hidden_members;
  ALTER TABLE public.leagues RENAME TO version_hidden_leagues;
  response:=public.get_league_version(f.league_id,f.user_ids[1],counter::text);
  PERFORM pg_temp.check_rules(response=jsonb_build_object('version',counter::text,'changes','[]'::jsonb),'unchanged read needs only the version row');
  ALTER TABLE public.version_hidden_changes RENAME TO league_changes;
  ALTER TABLE public.version_hidden_members RENAME TO league_members;
  ALTER TABLE public.version_hidden_leagues RENAME TO leagues;
  FOR n IN 1..135 LOOP
    UPDATE public.leagues SET name='Version retention '||n WHERE id=f.league_id;
  END LOOP;
  SELECT version INTO counter FROM public.league_versions WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules((SELECT count(*)=128 FROM public.league_changes WHERE league_id=f.league_id),'log retains 128 changes per league');
  response:=public.get_league_version(f.league_id,f.user_ids[1],'0');
  PERFORM pg_temp.check_rules(response->'changes'->0->>'topic'='catchup','old clients receive a full catchup signal');
  response:=public.get_league_version(f.league_id,f.user_ids[1],(counter+1)::text);
  PERFORM pg_temp.check_rules(response->>'version'=counter::text AND response->'changes'='[]'::jsonb,'future cursor returns current counter');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
