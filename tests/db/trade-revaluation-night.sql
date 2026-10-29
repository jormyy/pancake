\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='120s';
SELECT set_config('trade_night.phase',:'phase',true);
\if :{?revaluations}
SELECT set_config('trade_night.revaluations',:'revaluations',true) IS NOT NULL;
\else
SELECT set_config('trade_night.revaluations','{}',true);
\endif
SELECT set_config('trade_night.clock',date_trunc('minute',now())::text,true);
CREATE TEMP TABLE night_calls(at timestamptz,kind text,milliseconds numeric);
CREATE TEMP TABLE night_values(trade_id uuid,at timestamptz,live boolean);
CREATE TEMP TABLE night_state(game_id uuid,started timestamptz,maximum_pending integer DEFAULT 0);
CREATE FUNCTION pg_temp.night_call(p_kind text,p_sql text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE started timestamptz:=clock_timestamp(); result jsonb;
BEGIN
  EXECUTE p_sql INTO result;
  INSERT INTO night_calls VALUES(current_setting('trade_night.clock')::timestamptz,p_kind,
    extract(epoch FROM clock_timestamp()-started)*1000);
  RETURN result;
END;
$$;
DO $$
DECLARE fn regprocedure;
BEGIN
  IF current_setting('cron.launch_active_jobs')<>'off' THEN RAISE EXCEPTION 'Disable scheduled jobs'; END IF;
  FOREACH fn IN ARRAY ARRAY[
    'public.get_trade_revaluation_inputs(uuid,uuid,uuid)'::regprocedure,
    'private.trade_revaluation_input_version(uuid)'::regprocedure,
    'private.refresh_queue_trade_revaluation(uuid,text,text,jsonb)'::regprocedure,
    'private.refresh_trade_values(uuid,uuid,bigint,jsonb)'::regprocedure,
    'private.trade_value_player_inputs(uuid,uuid,integer,uuid[],integer)'::regprocedure,
    'public.get_league_projection_rows(uuid,integer,date,text,uuid[],integer,integer)'::regprocedure
  ] LOOP
    EXECUTE replace(pg_get_functiondef(fn),'now()','(current_setting(''trade_night.clock'')::timestamptz)');
  END LOOP;
  IF to_regprocedure('private.begin_trade_revaluation(uuid,text)') IS NOT NULL THEN
    EXECUTE replace(pg_get_functiondef('private.begin_trade_revaluation(uuid,text)'::regprocedure),
      'now()','(current_setting(''trade_night.clock'')::timestamptz)');
  END IF;
END;
$$;
DO $$
DECLARE game uuid:=gen_random_uuid(); yr integer; payload jsonb; started timestamptz:=current_setting('trade_night.clock')::timestamptz;
BEGIN
  SELECT season_year INTO yr FROM public.league_seasons WHERE id=(SELECT league_season_id FROM public.trades WHERE status IN ('pending','accepted') LIMIT 1);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,started_at)
    VALUES(game,'002-trade-night',yr,1,started::date,'BOS','NYK','InProgress',started);
  SELECT jsonb_agg(jsonb_build_object('player_id',id,'game_id',game,'season_year',yr,'week_number',1,
    'minutes_played',20,'points',10,'rebounds',5,'assists',2,'did_not_play',false)) INTO payload
    FROM (SELECT id FROM public.players WHERE nba_team IS NOT NULL ORDER BY id LIMIT 25) selected;
  PERFORM public.save_live_game_stats_atomic(game,'002-trade-night',payload,0);
  INSERT INTO night_state(game_id,started) VALUES(game,started);
END;
$$;
CREATE FUNCTION pg_temp.night_step(p_live boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE trade record; work record; inputs jsonb; result jsonb; pending integer; valuation jsonb;
BEGIN
  FOR trade IN SELECT t.*,m.user_id FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
    WHERE t.status IN ('pending','accepted') ORDER BY t.id LOOP
    PERFORM pg_temp.night_call('check',format('SELECT public.view_refresh_work(NULL,NULL,%L::jsonb)',
      jsonb_build_object('operation','check-trade','tradeId',trade.id,'modelVersion','night')::text));
  END LOOP;
  SELECT count(*) INTO pending FROM private.work_items WHERE kind='trade-revaluation'
    AND payload->>'modelVersion'='night' AND status IN ('pending','failed');
  UPDATE night_state SET maximum_pending=GREATEST(maximum_pending,pending);
  FOR work IN SELECT * FROM private.work_items WHERE kind='trade-revaluation'
    AND payload->>'modelVersion'='night' AND status='pending'
    AND due_at<=current_setting('trade_night.clock')::timestamptz ORDER BY id LOOP
    UPDATE private.work_items SET status='running',lease_token=gen_random_uuid(),
      lease_until=current_setting('trade_night.clock')::timestamptz+interval '90 seconds' WHERE id=work.id;
    result:='true';
    IF current_setting('trade_night.phase')='after' THEN
      result:=pg_temp.night_call('begin',format('SELECT public.view_refresh_work(NULL,NULL,%L::jsonb)',
        jsonb_build_object('operation','begin-trade','tradeId',work.payload->>'tradeId','modelVersion','night')::text));
    END IF;
    IF result='true' THEN
      inputs:=pg_temp.night_call('inputs',format('SELECT public.get_trade_revaluation_inputs(%L,%L,%L)',
        work.payload->>'userId',work.payload->>'memberId',work.payload->>'tradeId'));
      IF inputs->'cachedRevaluation'->>'modelVersion' IS DISTINCT FROM 'night' THEN
        INSERT INTO night_values VALUES((work.payload->>'tradeId')::uuid,current_setting('trade_night.clock')::timestamptz,p_live);
        valuation:=COALESCE(current_setting('trade_night.revaluations')::jsonb->(work.payload->>'tradeId'),'{}')
          ||jsonb_build_object('inputVersion',inputs->>'inputVersion','modelVersion','night');
        result:=pg_temp.night_call('save',format('SELECT public.view_refresh_work(%L,NULL,%L::jsonb)',inputs->>'leagueId',
          jsonb_build_object('operation','publish-trade','seasonId',inputs->>'seasonId','tradeId',work.payload->>'tradeId',
            'revaluation',valuation)::text));
        IF result<>'true' THEN RAISE EXCEPTION 'A current night value must publish'; END IF;
      END IF;
    END IF;
    UPDATE private.work_items SET status='succeeded',completed_at=current_setting('trade_night.clock')::timestamptz,
      lease_token=NULL,lease_until=NULL WHERE id=work.id;
  END LOOP;
END;
$$;
DO $$
DECLARE frame integer; payload jsonb; game uuid; started timestamptz;
BEGIN
  SELECT game_id,s.started INTO game,started FROM night_state s;
  FOR frame IN 0..359 LOOP
    PERFORM set_config('trade_night.clock',(started+frame*interval '30 seconds')::text,true);
    SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('points',10+frame)) INTO payload FROM public.player_game_stats s WHERE game_id=game;
    PERFORM public.save_live_game_stats_atomic(game,'002-trade-night',payload,frame*30+1);
    PERFORM pg_temp.night_step(true);
  END LOOP;
  PERFORM set_config('trade_night.clock',(started+interval '3 hours')::text,true);
  PERFORM public.save_final_game_snapshot_atomic(game,'002-trade-night',payload,clock_timestamp(),100,99,'Final');
  FOR frame IN 0..20 LOOP
    PERFORM set_config('trade_night.clock',(started+interval '3 hours'+frame*interval '30 seconds')::text,true);
    PERFORM pg_temp.night_step(false);
  END LOOP;
  IF current_setting('trade_night.phase')='after' THEN
    IF EXISTS(SELECT 1 FROM (SELECT at-lag(at) OVER(PARTITION BY trade_id ORDER BY at) AS gap FROM night_values WHERE live) gaps
      WHERE gap<interval '10 minutes') THEN RAISE EXCEPTION 'Live values must be at least ten minutes apart'; END IF;
    IF EXISTS(SELECT 1 FROM public.trades t WHERE t.status IN ('pending','accepted') AND NOT EXISTS(
      SELECT 1 FROM private.trade_value_publications p WHERE p.trade_id=t.id AND p.input_fingerprint=private.trade_revaluation_input_version(t.id)))
      THEN RAISE EXCEPTION 'Final values must be current within ten minutes'; END IF;
    IF (SELECT sum(milliseconds)/3 FROM night_calls)>36000 THEN RAISE EXCEPTION 'Revaluation exceeds one percent of one CPU'; END IF;
  END IF;
END;
$$;
SELECT jsonb_build_object('phase',current_setting('trade_night.phase'),
  'live_revaluations',(SELECT count(*) FROM night_values WHERE live),
  'per_trade_per_hour',(SELECT jsonb_agg(to_jsonb(counts)) FROM (SELECT trade_id,count(*)/3.0 AS per_hour FROM night_values WHERE live GROUP BY trade_id) counts),
  'db_ms_per_hour',(SELECT sum(milliseconds)/3 FROM night_calls),
  'maximum_statement_ms',(SELECT max(milliseconds) FROM night_calls),
  'maximum_pending',(SELECT maximum_pending FROM night_state),
  'retained_work_items',(SELECT count(*) FROM private.work_items WHERE kind='trade-revaluation' AND payload->>'modelVersion'='night'),
  'final_delay_seconds',(SELECT COALESCE(max(extract(epoch FROM at-(SELECT started+interval '3 hours' FROM night_state))),0) FROM night_values WHERE NOT live));
ROLLBACK;
