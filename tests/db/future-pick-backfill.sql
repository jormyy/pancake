\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_future_pick(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END;
$$;
CREATE TEMP TABLE old_picks AS SELECT * FROM public.draft_picks;
CREATE TEMP TABLE old_leagues AS SELECT id,to_jsonb(league)-'future_pick_years'-CASE WHEN id='faab8d8f-6a60-4bbc-8f5d-44050b652cdd' THEN ARRAY['updated_at'] ELSE '{}'::text[] END AS row FROM public.leagues league;
CREATE TEMP TABLE old_notifications AS SELECT * FROM public.notification_outbox;
CREATE TEMP TABLE old_events AS SELECT * FROM public.league_events;
CREATE TEMP VIEW other_league_metadata AS
  SELECT 'versions' AS kind,to_jsonb(row) AS row FROM public.league_versions row WHERE league_id<>'faab8d8f-6a60-4bbc-8f5d-44050b652cdd'
  UNION ALL SELECT 'changes',to_jsonb(row) FROM public.league_changes row WHERE league_id<>'faab8d8f-6a60-4bbc-8f5d-44050b652cdd'
  UNION ALL SELECT 'hints',to_jsonb(row) FROM public.league_change_hints row WHERE league_id<>'faab8d8f-6a60-4bbc-8f5d-44050b652cdd';
CREATE TEMP TABLE old_metadata AS SELECT * FROM other_league_metadata;
CREATE TEMP TABLE old_version AS SELECT version FROM public.league_versions WHERE league_id='faab8d8f-6a60-4bbc-8f5d-44050b652cdd';
CREATE TEMP TABLE other_tables(name text,hash text);
DO $$
DECLARE relation record; hash text;
BEGIN
  FOR relation IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN (SELECT relname FROM pg_class WHERE relispartition) AND tablename NOT IN
    ('leagues','draft_picks','league_versions','league_changes','league_change_hints','league_events','notification_outbox') ORDER BY tablename LOOP
    EXECUTE format('SELECT md5(COALESCE(string_agg(row::text,'''' ORDER BY row::text),'''')) FROM (SELECT to_jsonb(t) AS row FROM public.%I t) data',relation.tablename) INTO hash;
    INSERT INTO other_tables VALUES(relation.tablename,hash);
  END LOOP;
END;
$$;
\ir ../../supabase/migrations/20261214000700_future_pick_years.sql
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.assert_future_pick((SELECT future_pick_years=5 FROM public.leagues WHERE id='faab8d8f-6a60-4bbc-8f5d-44050b652cdd'),'official league uses five future years');
SELECT pg_temp.assert_future_pick((SELECT count(*)=2 AND min(picks)=30 AND max(picks)=30 FROM (
  SELECT season_year,count(*) picks FROM public.draft_picks
  WHERE league_id='faab8d8f-6a60-4bbc-8f5d-44050b652cdd' AND season_year IN(2031,2032) GROUP BY season_year) years),'2031 and 2032 each contain 30 picks');
SELECT pg_temp.assert_future_pick(NOT EXISTS(SELECT 1 FROM public.draft_picks pick LEFT JOIN old_picks old ON old.id=pick.id
  WHERE old.id IS NULL AND (pick.league_id<>'faab8d8f-6a60-4bbc-8f5d-44050b652cdd' OR pick.season_year NOT IN(2031,2032)
    OR pick.current_owner_id<>pick.original_owner_id OR pick.round NOT BETWEEN 1 AND 3 OR pick.is_used)),'new picks belong to their original teams in the requested years');
SELECT pg_temp.assert_future_pick(NOT EXISTS(SELECT * FROM old_picks EXCEPT SELECT * FROM public.draft_picks),'every existing pick remains byte equivalent');
SELECT pg_temp.assert_future_pick(NOT EXISTS(SELECT id,row FROM old_leagues EXCEPT SELECT id,to_jsonb(league)-'future_pick_years'-CASE WHEN id='faab8d8f-6a60-4bbc-8f5d-44050b652cdd' THEN ARRAY['updated_at'] ELSE '{}'::text[] END FROM public.leagues league),'existing league fields are unchanged');
SELECT pg_temp.assert_future_pick(NOT EXISTS(SELECT 1 FROM public.leagues WHERE id<>'faab8d8f-6a60-4bbc-8f5d-44050b652cdd' AND future_pick_years<>3),'other leagues retain the default');
SELECT pg_temp.assert_future_pick((SELECT version>COALESCE((SELECT version FROM old_version),0) FROM public.league_versions WHERE league_id='faab8d8f-6a60-4bbc-8f5d-44050b652cdd'),'league version advances for clients');
DO $$
DECLARE relation record; hash text;
BEGIN
  FOR relation IN SELECT * FROM other_tables LOOP
    EXECUTE format('SELECT md5(COALESCE(string_agg(row::text,'''' ORDER BY row::text),'''')) FROM (SELECT to_jsonb(t) AS row FROM public.%I t) data',relation.name) INTO hash;
    PERFORM pg_temp.assert_future_pick(hash=relation.hash,'unchanged public.'||relation.name);
  END LOOP;
END;
$$;
SELECT pg_temp.assert_future_pick(NOT EXISTS(SELECT * FROM old_events EXCEPT SELECT * FROM public.league_events),
  'existing inventory events are preserved');
SELECT pg_temp.assert_future_pick(NOT EXISTS(SELECT 1 FROM public.league_events event LEFT JOIN old_events old ON old.id=event.id
  WHERE old.id IS NULL AND event.league_id<>'faab8d8f-6a60-4bbc-8f5d-44050b652cdd'),
  'new inventory events belong only to official league');
SELECT pg_temp.assert_future_pick(NOT EXISTS(SELECT * FROM old_notifications EXCEPT SELECT * FROM public.notification_outbox),
  'existing notification rows are preserved');
SELECT pg_temp.assert_future_pick(NOT EXISTS(SELECT 1 FROM public.notification_outbox notice LEFT JOIN old_notifications old ON old.id=notice.id
  WHERE old.id IS NULL AND (notice.data->>'leagueId'<>'faab8d8f-6a60-4bbc-8f5d-44050b652cdd' OR notice.event_type<>'league_settings_changed')),
  'setting notices are queued only for official league');
SELECT pg_temp.assert_future_pick(NOT EXISTS((SELECT * FROM old_metadata EXCEPT SELECT * FROM other_league_metadata)
  UNION ALL (SELECT * FROM other_league_metadata EXCEPT SELECT * FROM old_metadata)),
  'other league versions, changes, and hints are unchanged');
CREATE TEMP TABLE after_picks AS SELECT * FROM public.draft_picks;
CREATE TEMP TABLE after_versions AS SELECT * FROM public.league_versions;
\ir ../../supabase/migrations/20261214000700_future_pick_years.sql
SELECT pg_temp.assert_future_pick(NOT EXISTS((SELECT * FROM after_picks EXCEPT SELECT * FROM public.draft_picks)
  UNION ALL (SELECT * FROM public.draft_picks EXCEPT SELECT * FROM after_picks)),'rerun preserves all pick rows');
SELECT pg_temp.assert_future_pick(NOT EXISTS((SELECT * FROM after_versions EXCEPT SELECT * FROM public.league_versions)
  UNION ALL (SELECT * FROM public.league_versions EXCEPT SELECT * FROM after_versions)),'rerun publishes no spurious league version');
COMMIT;
