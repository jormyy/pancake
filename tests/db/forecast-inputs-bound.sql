\set ON_ERROR_STOP on
BEGIN;
\if :{?original}
\i :original
DROP INDEX IF EXISTS public.idx_pgs_forecast_history;
\endif
SET LOCAL statement_timeout='60s';
SET LOCAL client_min_messages=notice;
SET LOCAL plan_cache_mode=:'plan_mode';
SELECT set_config('forecast_bench.clock', :'clock', true);
SELECT set_config('forecast_bench.samples', :'samples', true);
SELECT set_config('forecast_bench.guard', :'guard', true);
SELECT set_config('forecast_bench.statistics', :'statistics', true);
LOAD 'auto_explain';
SET LOCAL auto_explain.log_min_duration=-1;
SET LOCAL auto_explain.log_analyze=on;
SET LOCAL auto_explain.log_buffers=on;
SET LOCAL auto_explain.log_timing=on;
SET LOCAL auto_explain.log_nested_statements=on;
SET LOCAL auto_explain.log_format=json;
SET LOCAL auto_explain.log_level=notice;
CREATE TEMP TABLE forecast_bound_samples(matchup_id uuid,sample integer,kind text,milliseconds numeric,shared_hit bigint,shared_read bigint);
CREATE TEMP TABLE forecast_bound_parity(matchup_id uuid,kind text,value text);
DO $$
BEGIN
  IF current_setting('forecast_bench.statistics')='stale' THEN
    CREATE TEMP TABLE forecast_game_status AS SELECT id,status FROM public.nba_games;
    SET LOCAL session_replication_role=replica;
    UPDATE public.nba_games SET status='Scheduled' WHERE status='Final';
    ANALYZE public.nba_games;
    UPDATE public.nba_games g SET status=s.status FROM forecast_game_status s WHERE g.id=s.id AND g.status<>s.status;
    SET LOCAL session_replication_role=origin;
  END IF;
END;
$$;
DO $$
DECLARE function_id regprocedure;
BEGIN
  FOREACH function_id IN ARRAY ARRAY[
    'public.prepare_matchup_forecast_inputs(uuid,date)'::regprocedure,
    'public.get_prepared_matchup_forecast_context(uuid)'::regprocedure,
    'public.get_league_projection_rows(uuid,integer,date,text,uuid[],integer,integer)'::regprocedure,
    'private.matchup_forecast_inputs_ready(uuid)'::regprocedure,
    'private.read_matchup_forecast_context(uuid)'::regprocedure
  ] LOOP
    EXECUTE replace(pg_get_functiondef(function_id), 'now()', '(current_setting(''forecast_bench.clock'')::timestamptz)');
  END LOOP;
END;
$$;
UPDATE public.nba_games SET status='InProgress',started_at=game_time
WHERE id=(SELECT id FROM public.nba_games
  WHERE game_date=(current_setting('forecast_bench.clock')::timestamptz AT TIME ZONE 'America/New_York')::date
    AND game_time<=current_setting('forecast_bench.clock')::timestamptz AND status='Scheduled'
  ORDER BY game_time,id LIMIT 1);
CREATE FUNCTION pg_temp.forecast_measure(matchup uuid,iteration integer,kind text,query text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE plan jsonb;
BEGIN
  EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '||query INTO plan;
  INSERT INTO forecast_bound_samples VALUES(matchup,iteration,kind,
    (plan->0->>'Planning Time')::numeric+(plan->0->>'Execution Time')::numeric,
    COALESCE((plan->0->'Plan'->>'Shared Hit Blocks')::bigint,0),
    COALESCE((plan->0->'Plan'->>'Shared Read Blocks')::bigint,0));
END;
$$;
DO $$
DECLARE matchup record; iteration integer; game_day date; dates date[]; ids uuid[]; value jsonb; view_name text;
  today date:=(current_setting('forecast_bench.clock')::timestamptz AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF (SELECT count(*) FROM public.matchups WHERE left(id::text,8) IN('07ad4dd3','ccb35830','e47fcb99'))<>3 THEN
    RAISE EXCEPTION 'The three production matchups are required';
  END IF;
  FOR matchup IN SELECT m.*,s.season_year FROM public.matchups m JOIN public.league_seasons s ON s.id=m.league_season_id
    WHERE left(m.id::text,8) IN('07ad4dd3','ccb35830','e47fcb99') ORDER BY m.id LOOP
    SELECT array_agg(player_id ORDER BY player_id) INTO ids FROM public.roster_players
      WHERE league_id=matchup.league_id AND league_season_id=matchup.league_season_id
        AND member_id IN(matchup.home_member_id,matchup.away_member_id);
    IF cardinality(ids)<40 THEN RAISE EXCEPTION 'Production-sized rosters are required'; END IF;
    SELECT array_agg(DISTINCT g.game_date ORDER BY g.game_date) INTO dates FROM public.nba_games g
      JOIN public.season_weeks w ON w.season_year=matchup.season_year AND w.week_number=matchup.week_number
      JOIN public.season_weeks e ON e.season_year=matchup.season_year AND e.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
      WHERE g.season_year=matchup.season_year AND g.game_date BETWEEN GREATEST(w.week_start,today) AND e.week_end
        AND public.is_regular_season_game_id(g.nba_game_id) AND g.status NOT IN('Final','Postponed','Cancelled');
    IF cardinality(dates)<2 THEN RAISE EXCEPTION 'At least two projection dates are required'; END IF;
    FOR iteration IN 1..current_setting('forecast_bench.samples')::integer LOOP
      PERFORM set_config('auto_explain.log_min_duration','-1',true);
      TRUNCATE private.forecast_player_history,private.forecast_season_points,private.forecast_projection_inputs;
      PERFORM set_config('auto_explain.log_min_duration',CASE WHEN iteration=1 THEN '0' ELSE '-1' END,true);
      PERFORM pg_temp.forecast_measure(matchup.id,iteration,'prepare_cold',format('SELECT public.prepare_matchup_forecast_inputs(%L)',matchup.id));
      FOREACH game_day IN ARRAY dates LOOP
        PERFORM pg_temp.forecast_measure(matchup.id,iteration,'date_cold:'||game_day,format('SELECT public.prepare_matchup_forecast_inputs(%L,%L)',matchup.id,game_day));
      END LOOP;
      PERFORM pg_temp.forecast_measure(matchup.id,iteration,'context',format('SELECT public.get_prepared_matchup_forecast_context(%L)',matchup.id));
      PERFORM pg_temp.forecast_measure(matchup.id,iteration,'prepare_warm',format('SELECT public.prepare_matchup_forecast_inputs(%L)',matchup.id));
      FOREACH game_day IN ARRAY dates LOOP
        PERFORM pg_temp.forecast_measure(matchup.id,iteration,'date_warm:'||game_day,format('SELECT public.prepare_matchup_forecast_inputs(%L,%L)',matchup.id,game_day));
      END LOOP;
      PERFORM set_config('auto_explain.log_min_duration','-1',true);
      UPDATE private.forecast_season_points SET source_revision='stale' WHERE league_id=matchup.league_id AND player_id=ANY(ids);
      PERFORM set_config('auto_explain.log_min_duration',CASE WHEN iteration=1 THEN '0' ELSE '-1' END,true);
      PERFORM pg_temp.forecast_measure(matchup.id,iteration,'season_changed',format('SELECT public.prepare_matchup_forecast_inputs(%L)',matchup.id));
      PERFORM set_config('auto_explain.log_min_duration','-1',true);
      IF iteration=1 THEN
        value:=public.get_prepared_matchup_forecast_context(matchup.id);
        IF jsonb_array_length(value->'history')<20 THEN RAISE EXCEPTION 'Production player history is required'; END IF;
        INSERT INTO forecast_bound_parity VALUES(matchup.id,'context',value::text);
        FOREACH game_day IN ARRAY dates LOOP
          FOREACH view_name IN ARRAY ARRAY['today','week_avg','week_total'] LOOP
            SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]') INTO value
              FROM public.get_league_projection_rows(matchup.league_id,matchup.season_year,game_day,view_name,ids,100,0) p;
            INSERT INTO forecast_bound_parity VALUES(matchup.id,'projection:'||game_day||':'||view_name,value::text);
          END LOOP;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
DO $$
DECLARE slow record;
BEGIN
  IF current_setting('forecast_bench.guard')='on' THEN
    SELECT matchup_id,kind,percentile_disc(0.95) WITHIN GROUP(ORDER BY milliseconds) AS p95,max(milliseconds) AS maximum
      INTO slow FROM forecast_bound_samples GROUP BY matchup_id,kind
      HAVING percentile_disc(0.95) WITHIN GROUP(ORDER BY milliseconds)>=300 OR max(milliseconds)>=1000
      ORDER BY max(milliseconds) DESC LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Forecast timing guard fails: %',row_to_json(slow); END IF;
  END IF;
END;
$$;
SELECT jsonb_build_object('clock',current_setting('forecast_bench.clock'),'mode',current_setting('plan_cache_mode'),
  'statistics',current_setting('forecast_bench.statistics'),
  'liveGames',(SELECT count(*) FROM public.nba_games WHERE game_date=(current_setting('forecast_bench.clock')::timestamptz AT TIME ZONE 'America/New_York')::date AND status='InProgress'),
  'samples',(SELECT jsonb_agg(to_jsonb(s)) FROM forecast_bound_samples s),
  'parity',(SELECT jsonb_agg(to_jsonb(p) ORDER BY matchup_id,kind) FROM forecast_bound_parity p));
ROLLBACK;
