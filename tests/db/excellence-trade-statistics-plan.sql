\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
SET LOCAL statement_timeout='90s';
SELECT id AS league_id FROM public.leagues ORDER BY id LIMIT 1 \gset
SELECT set_config('request.jwt.claim.role','service_role',true);
DELETE FROM public.dynasty_rankings WHERE source='onenumberhoops.com';
TRUNCATE public.dynasty_pick_values;
ANALYZE public.dynasty_rankings;
CREATE FUNCTION pg_temp.pick_values(p_league uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE value jsonb;
BEGIN
  SELECT jsonb_agg(to_jsonb(row)-'fetched_at' ORDER BY draft_year,round,tier) INTO value FROM public.get_dynasty_pick_values(p_league) row;
  RETURN value;
END; $$;
SELECT pg_temp.pick_values(:'league_id') FROM generate_series(1,6);
WITH players AS (
  SELECT player.id,row_number() OVER(ORDER BY player.id)::int AS rank FROM public.players player ORDER BY player.id LIMIT 450
), rows AS (
  SELECT jsonb_agg(jsonb_build_object('source_id',id::text,'name','Fixture','team','FA','positions',ARRAY['PG'],'rank',rank,'value',100,'player_id',id)) AS value FROM players
), picks AS (
  SELECT jsonb_agg(jsonb_build_object('year',year,'round',round,'tier',tier,'value',100)) AS value
  FROM generate_series(2026,2028) year CROSS JOIN generate_series(1,2) round CROSS JOIN unnest(ARRAY['early','mid','late']) tier
)
SELECT public.publish_trade_values(rows.value,picks.value,'fixture',clock_timestamp(),'json') FROM rows,picks;
EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT pg_temp.pick_values(:'league_id');
SELECT md5(pg_temp.pick_values(:'league_id')::text);
ROLLBACK;
