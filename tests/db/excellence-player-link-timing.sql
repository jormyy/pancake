\set ON_ERROR_STOP on
BEGIN;
SET LOCAL session_replication_role=replica;
TRUNCATE public.players CASCADE;
SET LOCAL session_replication_role=origin;
INSERT INTO public.players(first_name,last_name,nba_id,nba_team,position,eligible_positions,years_exp)
SELECT 'Timing',translate(md5(n::text),'0123456789','klmnopqrst'),CASE WHEN n<=1309 THEN 'timing-'||n END,'BOS','G',ARRAY['G'],0
FROM generate_series(1,2618) n;
ANALYZE public.players;
CREATE TEMP TABLE timing_records AS
SELECT jsonb_agg(jsonb_build_object('provider_id',nba_id,'display_name',display_name,'nba_team',nba_team,'position',position,'years_exp',years_exp) ORDER BY nba_id) AS records
FROM (SELECT * FROM public.players WHERE nba_id IS NOT NULL ORDER BY nba_id LIMIT 500) p;
GRANT SELECT ON timing_records TO service_role;
SET LOCAL ROLE service_role;
UPDATE public.players SET birthdate='1995-01-01',nba_team='DEN' WHERE nba_id='timing-1';
UPDATE public.players SET nba_team='BOS' WHERE nba_id='timing-1';
SET LOCAL statement_timeout='1s';
EXPLAIN (ANALYZE, BUFFERS) SELECT public.link_player_sources_atomic('nba',records,true) FROM timing_records;
DO $$
DECLARE receipt jsonb;
BEGIN
  SELECT public.link_player_sources_atomic('nba',records,true) INTO receipt FROM timing_records;
  IF jsonb_array_length(receipt->'results')<>500 OR EXISTS (
    SELECT FROM jsonb_array_elements(receipt->'results') r WHERE r->>'action'<>'unchanged' OR r->>'player_id' IS NULL
  ) THEN RAISE EXCEPTION 'Player link results differ'; END IF;
END;
$$;
ROLLBACK;
