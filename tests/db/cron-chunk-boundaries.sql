BEGIN;
\if :{?chunk_api_url}
SELECT set_config('app.supabase_url',:'chunk_api_url',true);
\else
SET LOCAL app.supabase_url='http://127.0.0.1:62381';
\endif
SET LOCAL app.edge_internal_token='offline-cron-chunk-recipe';
\ir rules-support.sql
\ir scheduler-chunk-support.sql
\ir notification-scan-reference.sql
CREATE TEMP TABLE chunk_fixture(league_id uuid,season_id uuid,matchup_id uuid,other_matchup_id uuid,future_matchup_id uuid);
CREATE TEMP TABLE chunk_function_sources AS SELECT pg_get_functiondef(oid) AS definition FROM pg_proc
  WHERE oid IN('private.matchup_forecast_input_fingerprint(uuid)'::regprocedure,
    'private.notif_lineup_candidates_scoped(timestamptz,uuid,uuid)'::regprocedure);
DO $$
DECLARE fixture record; matchup uuid:=gen_random_uuid(); other_matchup uuid:=gen_random_uuid(); future_matchup uuid:=gen_random_uuid();
  injured uuid:=gen_random_uuid(); benched uuid:=gen_random_uuid(); today date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(4,9632);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(9632,1,today,today+6),(9632,2,today+21,today+27);
  INSERT INTO public.players(id,first_name,last_name,nba_team,eligible_positions,injury_status)
    VALUES(injured,'Chunk','Injured','CHI',ARRAY['PG'],'Out'),(benched,'Chunk','Available','ATL',ARRAY['SG'],NULL);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(fixture.league_id,fixture.season_id,fixture.member_ids[1],injured,'draft'),
      (fixture.league_id,fixture.season_id,fixture.member_ids[2],benched,'draft');
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES('0029632001',9632,1,today,'BOS','NYK','InProgress',now()-interval '30 minutes'),
      ('0029632002',9632,1,today,'ATL','CHI','Scheduled',now()+interval '1 hour');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,fixture.league_id,fixture.season_id,1,fixture.member_ids[1],fixture.member_ids[2]),
      (other_matchup,fixture.league_id,fixture.season_id,1,fixture.member_ids[3],fixture.member_ids[4]),
      (future_matchup,fixture.league_id,fixture.season_id,2,fixture.member_ids[1],fixture.member_ids[2]);
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type)
    VALUES(fixture.league_id,fixture.season_id,fixture.member_ids[1],injured,1,today,'PG');
  INSERT INTO chunk_fixture VALUES(fixture.league_id,fixture.season_id,matchup,other_matchup,future_matchup);
END;
$$;
CREATE OR REPLACE FUNCTION private.matchup_forecast_input_fingerprint(p_matchup_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Forecast fingerprint ran inside a cron statement'; END;
$$;
CREATE OR REPLACE FUNCTION private.notif_lineup_candidates_scoped(p_now timestamptz,p_league_id uuid,p_member_id uuid)
RETURNS TABLE(event_type text,league_id uuid,member_id uuid,player_id uuid,game_date date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Notification candidates ran inside a cron statement'; END;
$$;
DO $$
DECLARE fixture chunk_fixture%ROWTYPE;
BEGIN
  SELECT * INTO fixture FROM chunk_fixture;
  DELETE FROM private.work_items;
  UPDATE private.worker_controls SET paused=false,scheduler_level='normal',scheduler_healthy_since=NULL WHERE id;
  INSERT INTO private.player_stats_hint_pending(league_id) VALUES(fixture.league_id) ON CONFLICT DO NOTHING;
  UPDATE public.league_change_hints SET updated_at=clock_timestamp()-interval '2 minutes' WHERE league_id=fixture.league_id AND topic='score';
  EXECUTE (SELECT command FROM cron.job WHERE jobname='io-hint-drain');
  PERFORM public.dispatch_work();
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='forecast-inputs'),
    'minute crons enqueue forecast input work without fingerprinting');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='notification-scan'),
    'minute crons enqueue notification work without scanning candidates');
  PERFORM pg_temp.check_rules(private.matchup_forecast_refresh_pending(fixture.matchup_id),
    'a pending input refresh makes the forecast stale immediately');
END;
$$;
DO $$
DECLARE source text;
BEGIN
  FOR source IN SELECT definition FROM chunk_function_sources LOOP EXECUTE source; END LOOP;
END;
$$;
DO $$
DECLARE fixture chunk_fixture%ROWTYPE; result jsonb; processed integer:=0;
BEGIN
  SELECT * INTO fixture FROM chunk_fixture;
  FOR step IN 1..1000 LOOP
    result:=public.run_scheduler_chunk('forecasts');
    PERFORM pg_temp.check_rules((result->>'processed')::integer BETWEEN 0 AND 1,'forecast chunk bound '||step);
    processed:=processed+(result->>'processed')::integer;
    EXIT WHEN NOT (result->>'remaining')::boolean;
  END LOOP;
  PERFORM pg_temp.check_rules(processed>=3,'separate chunks visit the two current matchups and the future period');
  PERFORM pg_temp.check_rules((SELECT input_fingerprint->>'inputs'=private.matchup_forecast_input_fingerprint(matchup_id)->>'inputs'
    FROM private.matchup_forecast_queue WHERE matchup_id=fixture.matchup_id),'the worker preserves the forecast fingerprint');
  PERFORM pg_temp.check_rules(NOT private.matchup_forecast_refresh_pending(fixture.matchup_id),'a completed refresh clears the stale gate');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE matchup_id=fixture.future_matchup_id
    AND available_at=((now() AT TIME ZONE 'America/New_York')::date+7)::timestamp AT TIME ZONE 'America/New_York'),
    'a future period wakes when it enters the preview window');
END;
$$;
CREATE TEMP TABLE chunk_race_fired(matchup_id uuid);
GRANT SELECT ON chunk_fixture TO postgres;
GRANT ALL ON chunk_race_fired TO postgres;
DO $$
DECLARE original text; instrumented text; result jsonb; target uuid;
BEGIN
  SELECT matchup_id INTO target FROM chunk_fixture;
  SELECT pg_get_functiondef('private.refresh_matchup_forecast_input(uuid)'::regprocedure) INTO original;
  instrumented:=replace(original,'  RETURN due;','  IF p_matchup_id IN(SELECT matchup_id FROM pg_temp.chunk_fixture) AND NOT EXISTS(SELECT 1 FROM pg_temp.chunk_race_fired) THEN
    INSERT INTO pg_temp.chunk_race_fired VALUES(p_matchup_id);
    UPDATE public.matchups SET home_points=COALESCE(home_points,0)+1 WHERE id=p_matchup_id;
  END IF; RETURN due;');
  EXECUTE instrumented;
  PERFORM private.queue_matchup_forecasts((SELECT league_id FROM chunk_fixture));
  FOR step IN 1..10 LOOP
    result:=public.run_scheduler_chunk('forecasts');
    EXIT WHEN EXISTS(SELECT 1 FROM chunk_race_fired);
  END LOOP;
  EXECUTE original;
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM chunk_race_fired),'the race changes inputs between fingerprinting and deadline publication');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE matchup_id=target AND available_at<=now()),
    'a concurrent input change retains its immediate deadline');
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT input_fingerprint->>'inputs'=private.matchup_forecast_input_fingerprint(target)->>'inputs'
    FROM private.matchup_forecast_queue WHERE matchup_id=target),'the retained request computes the newer inputs');
END;
$$;
DELETE FROM public.notification_outbox;
SELECT pg_temp.reference_notification_scan(now());
CREATE TEMP TABLE expected_chunk_notifications AS
  SELECT dedupe_key,member_id,event_type,title,body,data,category FROM public.notification_outbox;
DELETE FROM public.notification_outbox;
UPDATE private.notification_scan_state SET available_at=now(),scan_at=NULL,after_member_id=NULL;
SELECT public.notif_scan_due_atomic();
DO $$
BEGIN
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.notification_outbox),'enqueue does not run the notification scan');
END;
$$;
SELECT pg_temp.drain_notification_chunks();
DO $$
BEGIN
  PERFORM pg_temp.check_rules(NOT EXISTS(
    (SELECT * FROM expected_chunk_notifications EXCEPT SELECT dedupe_key,member_id,event_type,title,body,data,category FROM public.notification_outbox)
    UNION ALL (SELECT dedupe_key,member_id,event_type,title,body,data,category FROM public.notification_outbox EXCEPT SELECT * FROM expected_chunk_notifications)),
    'member chunks preserve every notification and its payload');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.notification_outbox WHERE event_type='lineup_inactive'),'the parity fixture covers inactive lineup notifications');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.notification_outbox WHERE event_type='lineup_empty'),'the parity fixture covers empty lineup notifications');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.run_scheduler_chunk(text,boolean,timestamptz)','EXECUTE'),
    'clients cannot run scheduler chunks');
  PERFORM pg_temp.reject_rules('SELECT public.run_scheduler_chunk(''unknown'')','Unknown scheduler chunk.','unknown work kinds are rejected');
  DELETE FROM private.work_items;
  INSERT INTO private.work_items(kind,key,status,attempts,due_at,lease_token,lease_until,payload)
    SELECT 'player-injuries','chunk-busy-'||n,'running',1,now(),gen_random_uuid(),clock_timestamp()+interval '5 minutes',jsonb_build_object('slot',n)
    FROM generate_series(1,3) n;
  PERFORM private.work_enqueue('notification-scan','background',now(),'{"schedulerChunk":"notifications"}');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_claim(1)),
    'chunk workers leave a slot for urgent requests');
  PERFORM private.work_enqueue('trade-estimate','foreground',now(),'{"foreground":true}');
  PERFORM pg_temp.check_rules((SELECT kind='trade-estimate' FROM private.work_claim(1)),
    'foreground trade work takes the reserved slot ahead of chunks');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
