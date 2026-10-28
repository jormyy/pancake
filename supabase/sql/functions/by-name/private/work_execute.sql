CREATE OR REPLACE FUNCTION private.work_execute(p_id bigint,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_function text; v_payload jsonb; v_tipoff timestamptz;
  v_previous text:=coalesce(current_setting('pancake.work_id',true),'');
BEGIN
  SELECT * INTO v_item FROM private.work_items WHERE id=p_id AND lease_token=p_token AND status='running' AND lease_until>now();
  IF NOT FOUND THEN RETURN; END IF;
  SELECT function_name INTO v_function FROM private.work_kinds WHERE kind=v_item.kind;
  v_payload:=v_item.payload;
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
    WHEN 'trade-publication' THEN PERFORM private.publish_trade_changes((v_payload->>'publicationId')::uuid);
    WHEN 'setup-season-rollover' THEN PERFORM private.roll_setup_league_seasons(now());
    WHEN 'daily-stat-corrections' THEN PERFORM public.queue_daily_stat_corrections();
    WHEN 'edge-invocation-reconcile' THEN PERFORM private.reconcile_edge_invocations();
    WHEN 'player-stats-hints' THEN PERFORM private.flush_player_stats_hints();
    WHEN 'league-inventory-hint-drain' THEN PERFORM private.flush_league_inventory_hints(1000);
    WHEN 'cleanup-trade-estimates' THEN PERFORM public.cleanup_trade_estimate_quotes();
    WHEN 'mock-room-expiry' THEN PERFORM public.expire_mock_draft_rooms();
    WHEN 'retention-prune' THEN
      PERFORM private.run_retention();
    ELSE RAISE EXCEPTION 'Unknown SQL work kind: %',v_item.kind;
  END CASE;
  PERFORM private.work_finish(p_id,p_token);
END;
$$;
