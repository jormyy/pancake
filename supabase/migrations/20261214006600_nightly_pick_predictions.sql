BEGIN;

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
    AND NOT ((now() AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (now() AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT EXISTS(SELECT 1 FROM public.nba_games WHERE status='InProgress')) THEN
    UPDATE private.work_items SET status='pending',due_at=private.trade_revaluation_next_change(),
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

COMMIT;
