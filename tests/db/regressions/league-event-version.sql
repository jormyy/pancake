\set ON_ERROR_STOP on
BEGIN;
\ir ../rules-support.sql
CREATE TEMP TABLE event_version_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9586);
SET CONSTRAINTS private.league_version_commit IMMEDIATE;
CREATE TEMP TABLE event_version_before AS SELECT version FROM public.league_versions
  WHERE league_id=(SELECT league_id FROM event_version_fixture);
INSERT INTO public.league_events(league_id,kind,summary,detail)
SELECT league_id,'settings.changed','Event version regression','{}' FROM event_version_fixture;
DO $$
BEGIN
  IF (SELECT version FROM public.league_versions WHERE league_id=(SELECT league_id FROM event_version_fixture))
    IS NOT DISTINCT FROM (SELECT version FROM event_version_before) THEN
    RAISE EXCEPTION 'BUG: a league event does not advance its screen version';
  END IF;
END;
$$;
ROLLBACK;
