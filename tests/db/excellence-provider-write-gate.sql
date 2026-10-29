\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
CREATE TEMP TABLE provider_gate_records AS
SELECT jsonb_agg(jsonb_build_object('provider_id',espn_id,'first_name',first_name,'last_name',last_name,
  'metadata',jsonb_build_object('nba_team',nba_team,'status',status,'injury_status',injury_status,
    'years_exp',years_exp,'birthdate',birthdate,'position',position,'eligible_positions',eligible_positions)) ORDER BY id) AS records
FROM (SELECT id,espn_id,first_name,last_name,nba_team,status,injury_status,years_exp,birthdate,position,eligible_positions
  FROM public.players WHERE espn_id IS NOT NULL AND nba_team IS NOT NULL ORDER BY id LIMIT 3) selected;
SELECT public.resolve_player_imports_atomic('espn',records) FROM provider_gate_records;
CREATE TEMP TABLE provider_gate_before AS SELECT pg_stat_get_xact_tuples_updated('public.players'::regclass) AS updated;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
SELECT public.resolve_player_imports_atomic('espn',records) FROM provider_gate_records;
SELECT jsonb_build_object('playerUpdates',pg_stat_get_xact_tuples_updated('public.players'::regclass)-updated) FROM provider_gate_before;
DO $$
DECLARE before_count bigint; result jsonb;
BEGIN
  SELECT updated INTO before_count FROM provider_gate_before;
  IF pg_stat_get_xact_tuples_updated('public.players'::regclass)<>before_count THEN
    RAISE EXCEPTION 'An identical provider import rewrites players';
  END IF;
  SELECT public.resolve_player_imports_atomic('espn',records) INTO result FROM provider_gate_records;
  IF jsonb_array_length(result->'results')<>3 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(result->'results') row WHERE row->>'action'<>'updated') THEN
    RAISE EXCEPTION 'The provider result contract changes';
  END IF;
END;
$$;
ROLLBACK;
