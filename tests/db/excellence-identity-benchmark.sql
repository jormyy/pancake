\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='500ms';
CREATE TEMP TABLE identity_records AS
SELECT jsonb_agg(jsonb_build_object('provider_id',nba_id,'display_name',display_name,'nba_team',nba_team) ORDER BY nba_id) AS records
FROM (SELECT nba_id,display_name,nba_team FROM public.players WHERE nba_id IS NOT NULL AND nba_team IS NOT NULL ORDER BY nba_id LIMIT 500) selected;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
SELECT id FROM public.players WHERE regexp_replace(lower(regexp_replace(normalize(display_name,NFD),U&'[\0300-\036F]','','g')),'[^a-z]','','g')='codymartin';
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
SELECT public.link_player_sources_atomic('nba',records,false) FROM identity_records;
SELECT md5(public.link_player_sources_atomic('nba',records,false)::text) AS result_hash FROM identity_records;
ROLLBACK;
