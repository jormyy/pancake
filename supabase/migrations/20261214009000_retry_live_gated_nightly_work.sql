CREATE OR REPLACE FUNCTION private.nightly_work_retry_at(p_now timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT CASE
    WHEN (p_now AT TIME ZONE 'America/New_York')::time>=time '04:00'
      AND (p_now AT TIME ZONE 'America/New_York')::time<time '06:00'
    THEN least(p_now+interval '1 minute',((p_now AT TIME ZONE 'America/New_York')::date+time '06:00') AT TIME ZONE 'America/New_York')
    ELSE (((p_now AT TIME ZONE 'America/New_York')::date
      +CASE WHEN (p_now AT TIME ZONE 'America/New_York')::time<time '04:00' THEN 0 ELSE 1 END
      +time '04:00') AT TIME ZONE 'America/New_York')
    END;
$$;


CREATE OR REPLACE FUNCTION private.work_execute(p_id bigint,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_function text; v_payload jsonb; v_tipoff timestamptz; v_chunk jsonb; v_claim jsonb; v_started timestamptz;
  v_previous text:=coalesce(current_setting('pancake.work_id',true),'');
BEGIN
  SELECT * INTO v_item FROM private.work_items WHERE id=p_id AND lease_token=p_token AND status='running' AND lease_until>now();
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM private.work_kinds WHERE kind=v_item.kind AND retired_at IS NOT NULL) THEN
    UPDATE private.work_items SET status='dead',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,
      invocation_key=NULL,last_error='Work kind is retired' WHERE id=p_id AND lease_token=p_token;
    RETURN;
  END IF;
  SELECT function_name INTO v_function FROM private.work_kinds WHERE kind=v_item.kind;
  v_payload:=v_item.payload;
  IF v_item.kind='trade-revaluation' THEN
    v_payload:=(v_payload-'inputs')||'{"latestInputs":true}'::jsonb;
  END IF;
  IF v_item.kind IN ('sync-players','sync-trade-values','sync-rankings','pick-predictions','trade-revaluation-scan','trade-revaluation-check')
    AND NOT ((now() AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (now() AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT private.live_slate_in_progress(now())) THEN
    UPDATE private.work_items SET status='pending',due_at=private.nightly_work_retry_at(now()),
      lease_token=NULL,lease_until=NULL,invocation_key=NULL WHERE id=p_id AND lease_token=p_token;
    RETURN;
  END IF;
  IF v_item.kind IN ('forecast-inputs','refresh-views') THEN v_function:=NULL; END IF;
  IF v_item.kind='forecast-inputs' THEN
    v_started:=clock_timestamp();
    LOOP
      v_chunk:=private.complete_forecast_input_chunk();
      EXIT WHEN NOT (v_chunk->>'remaining')::boolean OR clock_timestamp()-v_started>=interval '1 second';
    END LOOP;
    PERFORM private.work_finish(p_id,p_token);
    IF (v_chunk->>'remaining')::boolean THEN
      PERFORM private.work_enqueue('forecast-inputs',gen_random_uuid()::text,now(),'{"schedulerChunk":"forecasts"}');
    END IF;
    RETURN;
  END IF;
  IF v_item.kind='league-inventory-hint-drain' AND (v_payload->>'delay')::int=0 THEN v_function:=NULL; END IF;
  IF v_item.kind='pre-tipoff' THEN
    v_tipoff:=(v_payload->>'tipoffAt')::timestamptz;
    IF v_tipoff<=now()-interval '1 minute' THEN RAISE EXCEPTION 'Tipoff window has closed'; END IF;
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date) VALUES(v_tipoff,(v_tipoff AT TIME ZONE 'America/New_York')::date) ON CONFLICT DO NOTHING;
    UPDATE public.lineup_tipoff_dispatches SET status='queued',token=p_token,attempts=attempts+1,
      lease_until=v_item.lease_until,error=NULL,input_revision=input_revision+(input_fingerprint IS DISTINCT FROM v_payload->>'fingerprint')::int,
      input_fingerprint=v_payload->>'fingerprint' WHERE tipoff_at=v_tipoff;
    v_payload:=(v_payload-'fingerprint')||jsonb_build_object('token',p_token);
  END IF;
  IF v_function IS NOT NULL THEN
    PERFORM set_config('pancake.work_id',p_id::text,true);
    PERFORM public.invoke_edge_function(v_function,v_payload);
    PERFORM set_config('pancake.work_id',v_previous,true);
    RETURN;
  END IF;
  CASE v_item.kind
    WHEN 'refresh-views' THEN
      FOR v_claim IN SELECT value FROM jsonb_array_elements(public.view_refresh_work(p_params:='{"operation":"claim"}')) LOOP
        PERFORM public.view_refresh_work(p_league_id:=(v_claim->>'leagueId')::uuid,
          p_params:=v_claim||jsonb_build_object('operation','complete'));
      END LOOP;
    WHEN 'refresh-live-matchups' THEN PERFORM private.refresh_live_matchup_totals();
    WHEN 'trade-publication' THEN PERFORM private.publish_trade_changes((v_payload->>'publicationId')::uuid);
    WHEN 'setup-season-rollover' THEN PERFORM private.roll_setup_league_seasons(now());
    WHEN 'daily-stat-corrections' THEN PERFORM public.queue_daily_stat_corrections();
    WHEN 'missing-final-stats' THEN PERFORM private.reconcile_missing_final_stats(now(),(v_payload->>'beforeDate')::date);
    WHEN 'edge-invocation-reconcile' THEN PERFORM private.reconcile_edge_invocations();
    WHEN 'player-stats-hints' THEN PERFORM private.flush_player_stats_hints();
    WHEN 'league-inventory-hint-drain' THEN PERFORM private.flush_league_inventory_hints(1000);
    WHEN 'cleanup-trade-estimates' THEN PERFORM public.cleanup_trade_estimate_quotes();
    WHEN 'mock-room-expiry' THEN PERFORM public.expire_mock_draft_rooms();
    WHEN 'public-read-retention' THEN PERFORM public.public_prune_read_log();
    WHEN 'retention-prune' THEN PERFORM private.run_retention();
    ELSE RAISE EXCEPTION 'Unknown SQL work kind: %',v_item.kind;
  END CASE;
  PERFORM private.work_finish(p_id,p_token);
END;
$$;


CREATE OR REPLACE FUNCTION private.enqueue_trade_revaluation_scan(p_season_id uuid,p_version bigint,p_model text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE selected_league uuid; source_version text; previous private.trade_revaluation_scans%ROWTYPE;
BEGIN
  SELECT league_id INTO selected_league FROM public.league_seasons WHERE id=p_season_id;
  IF NOT EXISTS(SELECT 1 FROM public.trades WHERE league_season_id=p_season_id AND status IN ('pending','accepted')) THEN
    DELETE FROM private.trade_revaluation_scans WHERE league_season_id=p_season_id;
    RETURN false;
  END IF;
  IF p_model IS NOT NULL THEN
    source_version:=private.trade_revaluation_source_version(p_season_id);
    SELECT * INTO previous FROM private.trade_revaluation_scans WHERE league_season_id=p_season_id;
    IF previous.source_version=source_version AND previous.model_version=p_model AND previous.next_change_at>now()
      AND NOT EXISTS(
        SELECT 1 FROM jsonb_each_text(previous.fingerprints) input
        WHERE NOT EXISTS(SELECT 1 FROM private.trade_value_publications published WHERE published.trade_id=input.key::uuid
          AND published.input_fingerprint=input.value AND published.model_version=p_model)
        AND NOT EXISTS(SELECT 1 FROM private.work_items work WHERE work.kind='trade-revaluation'
          AND work.key=input.key||':'||p_model||':latest' AND work.status IN ('pending','running','failed')
          AND work.payload->>'inputFingerprint'=input.value)
      ) THEN
      UPDATE private.trade_value_publications published SET version=queued.version,valid_until='infinity'
      FROM jsonb_each_text(previous.fingerprints) input JOIN public.trades trade ON trade.id=input.key::uuid
        JOIN private.screen_refresh_queue queued ON queued.league_season_id=trade.league_season_id
      WHERE published.trade_id=trade.id AND published.input_fingerprint=input.value
        AND published.model_version=p_model AND published.version<queued.version;
      RETURN false;
    END IF;
  END IF;
  RETURN private.work_enqueue('trade-revaluation-scan',p_season_id::text||':'||
    ((CASE WHEN (now() AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (now() AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT private.live_slate_in_progress(now()) THEN now() ELSE private.nightly_work_retry_at(now()) END) AT TIME ZONE 'America/New_York')::date::text,(CASE WHEN (now() AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (now() AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT private.live_slate_in_progress(now()) THEN now() ELSE private.nightly_work_retry_at(now()) END),
    jsonb_build_object('revaluationScan',true,'leagueId',selected_league,'seasonId',p_season_id,'version',p_version),selected_league) IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.enqueue_trade_revaluation_scan(uuid,bigint,text) FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION private.refresh_queue_trade_revaluation(p_trade_id uuid,p_fingerprint text,p_model text,p_inputs jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE trade record; work_key text; work_payload jsonb; existing private.work_items%ROWTYPE; due timestamptz; queued_id bigint;
BEGIN
  SELECT t.*,m.user_id,q.version AS screen_version INTO trade FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
    JOIN private.screen_refresh_queue q ON q.league_season_id=t.league_season_id
    WHERE t.id=p_trade_id AND t.status IN ('pending','accepted');
  IF NOT FOUND OR p_fingerprint IS NULL OR p_model IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM private.trade_value_publications WHERE trade_id=trade.id
    AND input_fingerprint=p_fingerprint AND model_version=p_model) THEN
    UPDATE private.trade_value_publications SET version=GREATEST(version,trade.screen_version),valid_until='infinity'
      WHERE trade_id=trade.id AND version<trade.screen_version;
    RETURN false;
  END IF;
  due:=now();
  SELECT GREATEST(now(),next_allowed_at) INTO due FROM private.trade_revaluation_schedule WHERE trade_id=trade.id;
  IF due IS NULL THEN
    due:=CASE WHEN EXISTS(SELECT 1 FROM private.trade_value_publications WHERE trade_id=trade.id)
      THEN (CASE WHEN (now() AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (now() AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT private.live_slate_in_progress(now()) THEN now() ELSE private.nightly_work_retry_at(now()) END) ELSE now() END;
  END IF;
  work_key:=trade.id::text||':'||p_model||':latest';
  work_payload:=jsonb_build_object('tradeId',trade.id,'memberId',trade.proposer_member_id,'userId',trade.user_id,
    'inputFingerprint',p_fingerprint,'modelVersion',p_model,'latestInputs',true);
  SELECT * INTO existing FROM private.work_items WHERE kind='trade-revaluation' AND key=work_key FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    IF existing.status='running' THEN RETURN false; END IF;
    UPDATE private.work_items SET status='pending',attempts=CASE WHEN existing.status IN ('succeeded','dead') THEN 0 ELSE attempts END,
      due_at=CASE WHEN existing.status IN ('pending','failed') THEN LEAST(existing.due_at,due) ELSE due END,
      completed_at=NULL,payload=work_payload,last_error=NULL,invocation_key=NULL
      WHERE id=existing.id;
    RETURN true;
  END IF;
  IF EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation' AND key=work_key) THEN RETURN false; END IF;
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
    VALUES('trade-revaluation',work_key,due,work_payload,trade.league_id) ON CONFLICT DO NOTHING RETURNING id INTO queued_id;
  RETURN queued_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.nightly_work_retry_at(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
