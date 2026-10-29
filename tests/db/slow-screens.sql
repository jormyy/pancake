\set ON_ERROR_STOP on
SET LOCAL statement_timeout='120s';
SET LOCAL auto_explain.log_min_duration=-1;
CREATE TEMP TABLE slow_fixture AS
WITH chosen AS (
  SELECT league.id FROM public.leagues league JOIN public.roster_players roster ON roster.league_id=league.id
  WHERE league.deleted_at IS NULL GROUP BY league.id ORDER BY count(*) DESC,league.id LIMIT 1
)
SELECT chosen.id AS league_id,member.id AS member_id,member.user_id FROM chosen CROSS JOIN LATERAL (
  SELECT id,user_id FROM public.league_members WHERE league_id=chosen.id AND user_id IS NOT NULL ORDER BY id LIMIT 3
) member;
CREATE TEMP TABLE slow_measurements(member_id uuid,name text,sample integer,milliseconds numeric,buffers bigint);
GRANT SELECT ON slow_fixture TO authenticated;
GRANT INSERT ON slow_measurements TO authenticated;
CREATE FUNCTION pg_temp.assert_slow_cost(milliseconds numeric,buffers bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF milliseconds>=60 OR buffers>=3000 THEN
    RAISE EXCEPTION 'Slow screen guard fails: % ms, % buffers',milliseconds,buffers USING ERRCODE='P0100';
  END IF;
END;
$$;
DO $$
DECLARE rejected boolean:=false; plan jsonb;
BEGIN
  EXECUTE 'EXPLAIN(ANALYZE,TIMING OFF,FORMAT JSON) SELECT pg_sleep(0.07)' INTO plan;
  BEGIN
    PERFORM pg_temp.assert_slow_cost((plan->0->>'Execution Time')::numeric,0);
  EXCEPTION WHEN SQLSTATE 'P0100' THEN rejected:=true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'The delay guard accepted a slow read'; END IF;
  rejected:=false;
  BEGIN
    PERFORM pg_temp.assert_slow_cost(0,3000);
  EXCEPTION WHEN SQLSTATE 'P0100' THEN rejected:=true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'The buffer guard accepted an excessive read'; END IF;
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE fixture record; name text; sample integer; plan jsonb;
BEGIN
  IF (SELECT count(*) FROM slow_fixture)<>3 THEN RAISE EXCEPTION 'Three managers are required'; END IF;
  FOR fixture IN SELECT * FROM slow_fixture LOOP
    PERFORM set_config('request.jwt.claim.sub',fixture.user_id::text,true);
    FOREACH name IN ARRAY ARRAY['view_roster','view_players','view_league','view_trades'] LOOP
      FOR sample IN 0..5 LOOP
        EXECUTE format('EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT public.%I(%L::uuid,%L::uuid)',name,fixture.league_id,fixture.member_id) INTO plan;
        INSERT INTO slow_measurements VALUES(fixture.member_id,name,sample,(plan->0->>'Execution Time')::numeric,
          COALESCE((plan->0->'Plan'->>'Shared Hit Blocks')::bigint,0)+COALESCE((plan->0->'Plan'->>'Shared Read Blocks')::bigint,0));
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;
RESET ROLE;
DO $$
DECLARE measurement record;
BEGIN
  FOR measurement IN SELECT name,member_id,percentile_disc(0.95) WITHIN GROUP(ORDER BY milliseconds) AS p95,max(buffers) AS buffers
    FROM slow_measurements WHERE sample>0 GROUP BY name,member_id LOOP
    PERFORM pg_temp.assert_slow_cost(measurement.p95,measurement.buffers);
  END LOOP;
END;
$$;
SELECT name,count(*) AS samples,percentile_disc(0.95) WITHIN GROUP(ORDER BY milliseconds) AS p95,max(buffers) AS buffers
FROM slow_measurements WHERE sample>0 GROUP BY name ORDER BY name;
