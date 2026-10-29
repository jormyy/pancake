\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='120s';
SET LOCAL auto_explain.log_min_duration=-1;
CREATE TEMP TABLE cost_fixture AS
WITH league AS (
  SELECT l.id FROM public.leagues l JOIN public.roster_players r ON r.league_id=l.id
  WHERE l.deleted_at IS NULL GROUP BY l.id ORDER BY count(*) DESC,l.id LIMIT 1
)
SELECT l.id AS league_id,m.id AS member_id,m.user_id,
  (SELECT other.id FROM public.league_members other WHERE other.league_id=l.id AND other.id<>m.id ORDER BY other.id LIMIT 1) AS other_member_id
FROM league l CROSS JOIN LATERAL (
  SELECT id,user_id FROM public.league_members WHERE league_id=l.id AND user_id IS NOT NULL ORDER BY id LIMIT 1
) m;
CREATE TEMP TABLE cost_measurements(name text,sample integer,milliseconds numeric,buffers bigint,rows bigint);
GRANT SELECT ON cost_fixture TO authenticated,service_role;
GRANT INSERT,SELECT ON cost_measurements TO authenticated,service_role;
CREATE FUNCTION pg_temp.assert_screen_cost(milliseconds numeric,buffers bigint,time_limit numeric,buffer_limit bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF milliseconds>=time_limit OR buffers>=buffer_limit THEN
    RAISE EXCEPTION 'Screen cost guard fails: % ms, % buffers',milliseconds,buffers USING ERRCODE='P0100';
  END IF;
END;
$$;
CREATE FUNCTION pg_temp.measure_screen_cost(name text,query text,sample integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE plan jsonb;
BEGIN
  EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '||query INTO plan;
  INSERT INTO cost_measurements VALUES(name,sample,(plan->0->>'Execution Time')::numeric,
    COALESCE((plan->0->'Plan'->>'Shared Hit Blocks')::bigint,0)+COALESCE((plan->0->'Plan'->>'Shared Read Blocks')::bigint,0),
    (plan->0->'Plan'->>'Actual Rows')::bigint);
END;
$$;
DO $$
DECLARE failed boolean:=false; milliseconds numeric; plan jsonb;
BEGIN
  EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT pg_sleep(0.025)' INTO plan;
  milliseconds:=(plan->0->>'Execution Time')::numeric;
  BEGIN
    PERFORM pg_temp.assert_screen_cost(milliseconds,0,2,3000);
  EXCEPTION WHEN SQLSTATE 'P0100' THEN failed:=true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'The timing negative control does not fail'; END IF;
  failed:=false;
  BEGIN
    PERFORM pg_temp.assert_screen_cost(0,3000,150,3000);
  EXCEPTION WHEN SQLSTATE 'P0100' THEN failed:=true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'The buffer negative control does not fail'; END IF;
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE fixture record; name text; sample integer; query text;
BEGIN
  SELECT * INTO STRICT fixture FROM cost_fixture;
  PERFORM set_config('request.jwt.claim.sub',fixture.user_id::text,true);
  FOREACH name IN ARRAY ARRAY['view_roster','view_home','view_trades','view_league','view_players','view_lineup','view_standings'] LOOP
    query:=format('SELECT public.%I(%L::uuid,%L::uuid)',name,fixture.league_id,fixture.member_id);
    FOR sample IN 0..5 LOOP PERFORM pg_temp.measure_screen_cost(name,query,sample); END LOOP;
  END LOOP;
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$
DECLARE fixture record; sample integer;
BEGIN
  SELECT * INTO STRICT fixture FROM cost_fixture;
  FOR sample IN 0..5 LOOP
    PERFORM pg_temp.measure_screen_cost('get_league_version',format('SELECT public.get_league_version(%L::uuid,%L::uuid)',fixture.league_id,fixture.user_id),sample);
    PERFORM pg_temp.measure_screen_cost('preview_trade_legality',format('SELECT public.preview_trade_legality(%L::uuid,%L::uuid,ARRAY[%L::uuid,%L::uuid],%L::jsonb)',fixture.user_id,fixture.league_id,fixture.member_id,fixture.other_member_id,'[]'),sample);
  END LOOP;
END;
$$;
RESET ROLE;
DO $$
DECLARE measurement record;
BEGIN
  FOR measurement IN SELECT name,percentile_disc(0.95) WITHIN GROUP(ORDER BY milliseconds) AS p95,max(buffers) AS buffers
    FROM cost_measurements WHERE sample>0 GROUP BY name LOOP
    PERFORM pg_temp.assert_screen_cost(measurement.p95,measurement.buffers,
      CASE measurement.name WHEN 'get_league_version' THEN 2 WHEN 'preview_trade_legality' THEN 100 ELSE 150 END,3000);
  END LOOP;
END;
$$;
SELECT name,percentile_disc(0.5) WITHIN GROUP(ORDER BY milliseconds) AS p50,
  percentile_disc(0.95) WITHIN GROUP(ORDER BY milliseconds) AS p95,max(buffers) AS buffers,max(rows) AS rows
FROM cost_measurements WHERE sample>0 GROUP BY name ORDER BY name;
ROLLBACK;
