\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='120s';
SET LOCAL lock_timeout='2s';
\if :{?phase}
SELECT set_config('writer_bench.phase',:'phase',true);
\else
SELECT set_config('writer_bench.phase','report',true);
\endif
CREATE TEMP TABLE writer_games AS
SELECT gen_random_uuid() AS id,g.id AS original_id,'002-trade-writer-'||row_number() OVER(ORDER BY g.id) AS provider,
  g.season_year,g.week_number,g.home_team,g.away_team
FROM public.nba_games g
WHERE g.season_year=(SELECT max(season_year) FROM public.league_seasons WHERE is_current)
  AND (SELECT count(*) FROM public.player_game_stats s WHERE s.game_id=g.id AND NOT s.did_not_play)>=18
ORDER BY g.id LIMIT 8;
INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time,started_at)
SELECT id,provider,season_year,week_number,current_date,home_team,away_team,'InProgress',now()-interval '1 hour',now()-interval '1 hour'
FROM writer_games;
INSERT INTO public.player_game_stats
SELECT (jsonb_populate_record(NULL::public.player_game_stats,to_jsonb(s)||jsonb_build_object(
  'id',gen_random_uuid(),'game_id',g.id,'game_date',current_date))).*
FROM writer_games g CROSS JOIN LATERAL (
  SELECT * FROM public.player_game_stats s WHERE s.game_id=g.original_id AND NOT s.did_not_play ORDER BY player_id LIMIT 25
) s;
CREATE TEMP TABLE writer_boxes AS
SELECT g.id,g.provider,jsonb_agg(to_jsonb(s)||jsonb_build_object('points',s.points+1,'minutes_played',s.minutes_played+1) ORDER BY s.player_id) AS payload
FROM writer_games g JOIN public.player_game_stats s ON s.game_id=g.id GROUP BY g.id,g.provider;
CREATE TEMP TABLE writer_players AS
SELECT id,years_exp,jsonb_build_object('provider_id',espn_id,'first_name',first_name,'last_name',last_name,
  'metadata',jsonb_build_object('nba_team',nba_team,'status',status,'injury_status',injury_status,
    'years_exp',COALESCE(years_exp,0)+1,'position',position,'eligible_positions',eligible_positions)) AS payload
FROM public.players WHERE espn_id IS NOT NULL AND nba_team IS NOT NULL ORDER BY id LIMIT 50;
CREATE TEMP TABLE writer_projections AS
SELECT p.id AS player_id,s.season_year,COALESCE((SELECT week_number FROM public.season_weeks
  WHERE season_year=s.season_year AND current_date BETWEEN week_start AND week_end LIMIT 1),1) AS week_number
FROM public.players p CROSS JOIN (SELECT max(season_year) AS season_year FROM public.league_seasons WHERE is_current) s
WHERE p.nba_team IS NOT NULL ORDER BY p.id LIMIT 500;
CREATE TEMP TABLE writer_rpc_samples(id bigint GENERATED ALWAYS AS IDENTITY,milliseconds numeric);
CREATE TEMP TABLE writer_samples(kind text,iteration integer,enabled boolean,milliseconds numeric,buffers bigint,rpc_milliseconds jsonb);

CREATE FUNCTION pg_temp.writer_run(p_kind text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE item record; changed integer:=0; expected integer; result jsonb; started timestamptz;
BEGIN
  IF p_kind IN ('live','final') THEN
    FOR item IN SELECT * FROM writer_boxes ORDER BY id LOOP
      started:=clock_timestamp();
      IF p_kind='live' THEN
        changed:=changed+public.save_live_game_stats_atomic(item.id,item.provider,item.payload,60);
      ELSE
        changed:=changed+public.save_final_game_snapshot_atomic(item.id,item.provider,item.payload,clock_timestamp(),100,99,'Final');
      END IF;
      INSERT INTO writer_rpc_samples(milliseconds) VALUES(extract(epoch FROM clock_timestamp()-started)*1000);
    END LOOP;
    SELECT sum(jsonb_array_length(payload)) INTO expected FROM writer_boxes;
    IF changed<>expected OR changed NOT BETWEEN 150 AND 300 THEN RAISE EXCEPTION 'The tick must change 150 to 300 rows: %',changed; END IF;
  ELSIF p_kind='players' THEN
    started:=clock_timestamp();
    SELECT public.resolve_player_imports_atomic('espn',jsonb_agg(payload ORDER BY id)) INTO result FROM writer_players;
    INSERT INTO writer_rpc_samples(milliseconds) VALUES(extract(epoch FROM clock_timestamp()-started)*1000);
    SELECT count(*) INTO changed FROM public.players p JOIN writer_players original USING(id)
      WHERE p.years_exp=COALESCE(original.years_exp,0)+1;
    IF changed<>50 THEN RAISE EXCEPTION 'The player sync must change 50 rows: %',changed; END IF;
  ELSE
    started:=clock_timestamp();
    INSERT INTO public.player_projections(player_id,season_year,week_number,projected_stat_points,fetched_at)
    SELECT player_id,season_year,week_number,101,clock_timestamp() FROM writer_projections
    ON CONFLICT(player_id,season_year,week_number) DO UPDATE SET
      projected_stat_points=EXCLUDED.projected_stat_points,fetched_at=EXCLUDED.fetched_at;
    GET DIAGNOSTICS changed=ROW_COUNT;
    INSERT INTO writer_rpc_samples(milliseconds) VALUES(extract(epoch FROM clock_timestamp()-started)*1000);
    IF changed<300 THEN RAISE EXCEPTION 'The projection sync must change at least 300 rows: %',changed; END IF;
  END IF;
  RETURN changed;
END;
$$;

DO $$
DECLARE kind text; iteration integer; enabled boolean; target record; plan jsonb; milliseconds numeric; buffers bigint; rpc_times jsonb;
BEGIN
  IF current_setting('cron.launch_active_jobs')<>'off' THEN RAISE EXCEPTION 'Disable scheduled jobs'; END IF;
  FOREACH kind IN ARRAY ARRAY['live','final','players','projections'] LOOP
    FOR iteration IN 0..30 LOOP
      FOREACH enabled IN ARRAY CASE WHEN iteration%2=0 THEN ARRAY[false,true] ELSE ARRAY[true,false] END LOOP
        FOR target IN SELECT tgrelid::regclass AS relation,tgname FROM pg_trigger
          WHERE tgfoid='private.track_trade_input_revision()'::regprocedure LOOP
          EXECUTE format('ALTER TABLE %s %s TRIGGER %I',target.relation,CASE WHEN enabled THEN 'ENABLE' ELSE 'DISABLE' END,target.tgname);
        END LOOP;
        BEGIN
          EXECUTE format('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT pg_temp.writer_run(%L)',kind) INTO plan;
          milliseconds:=(plan->0->>'Execution Time')::numeric;
          buffers:=COALESCE((plan->0->'Plan'->>'Shared Hit Blocks')::bigint,0)+COALESCE((plan->0->'Plan'->>'Shared Read Blocks')::bigint,0);
          SELECT jsonb_agg(sample.milliseconds ORDER BY sample.id) INTO rpc_times FROM writer_rpc_samples sample;
          RAISE EXCEPTION USING ERRCODE='PZ001';
        EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL;
        END;
        IF iteration>0 THEN INSERT INTO writer_samples VALUES(kind,iteration,enabled,milliseconds,buffers,rpc_times); END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;
WITH pairs AS (
  SELECT kind,iteration,max(milliseconds) FILTER(WHERE enabled) AS added,
    max(milliseconds) FILTER(WHERE NOT enabled) AS baseline,
    max(buffers) FILTER(WHERE enabled)-max(buffers) FILTER(WHERE NOT enabled) AS added_buffers
  FROM writer_samples GROUP BY kind,iteration
), summary AS (
  SELECT kind,count(*) AS pairs,avg(baseline) AS without_ms,avg(added) AS with_ms,avg(added-baseline) AS overhead_ms,
    100*(avg(added)/avg(baseline)-1) AS overhead_percent,
    percentile_cont(.95) WITHIN GROUP(ORDER BY added-baseline) AS overhead_p95_ms,
    max(added) AS maximum_ms,avg(added_buffers) AS added_buffers
  FROM pairs GROUP BY kind
)
SELECT jsonb_agg(to_jsonb(summary) ORDER BY kind) FROM summary;
CREATE TEMP TABLE writer_rpc_report AS
WITH samples AS (
  SELECT kind,iteration,enabled,t.ordinality,t.value::numeric AS milliseconds
  FROM writer_samples CROSS JOIN LATERAL jsonb_array_elements_text(rpc_milliseconds) WITH ORDINALITY t
), pairs AS (
  SELECT kind,iteration,ordinality,max(milliseconds) FILTER(WHERE enabled) AS with_ms,
    max(milliseconds) FILTER(WHERE NOT enabled) AS without_ms FROM samples GROUP BY kind,iteration,ordinality
)
SELECT kind,ordinality,avg(without_ms) AS without_ms,avg(with_ms) AS with_ms,
  avg(with_ms-without_ms) AS added_ms,100*(avg(with_ms)/avg(without_ms)-1) AS added_percent,
  percentile_cont(.95) WITHIN GROUP(ORDER BY with_ms-without_ms) AS added_p95_ms
FROM pairs GROUP BY kind,ordinality;
SELECT jsonb_agg(to_jsonb(r) ORDER BY kind,ordinality) FROM writer_rpc_report r;
DO $$
BEGIN
  IF current_setting('writer_bench.phase')='after' AND EXISTS(SELECT 1 FROM writer_rpc_report WHERE added_ms>=3 OR added_percent>=5) THEN
    RAISE EXCEPTION 'Writer trigger overhead exceeds three milliseconds or five percent';
  END IF;
END;
$$;
SELECT jsonb_build_object('games',count(*),'rows',sum(jsonb_array_length(payload))) FROM writer_boxes;
ROLLBACK;
