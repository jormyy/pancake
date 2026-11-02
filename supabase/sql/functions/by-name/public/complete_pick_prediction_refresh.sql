-- Canonical SQL source for public.complete_pick_prediction_refresh.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.complete_pick_prediction_refresh(p_source_version text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_scope record; v_scan bigint;
BEGIN
  PERFORM 1 FROM private.trade_value_sync_state WHERE id AND content_sha256=p_source_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM public.draft_picks pick WHERE pick.round BETWEEN 1 AND 3
    AND EXISTS(SELECT 1 FROM public.league_seasons WHERE league_id=pick.league_id)
    AND pick.prediction_source_sha256 IS DISTINCT FROM p_source_version) THEN
    RAISE EXCEPTION 'Every league pick must refresh before trade re-analysis.' USING ERRCODE='40001';
  END IF;
  PERFORM public.queue_trade_estimate_reanalysis('onenumber-trade-v1-picks-v1');
  FOR v_scope IN SELECT DISTINCT queued.league_id,queued.league_season_id,queued.version
    FROM private.screen_refresh_queue queued JOIN public.trades trade ON trade.league_season_id=queued.league_season_id
    WHERE trade.status IN ('pending','accepted') LOOP
    v_scan:=private.work_enqueue('trade-revaluation-scan',v_scope.league_season_id::text||':source:'||
      (now() AT TIME ZONE 'America/New_York')::date::text,now(),
      jsonb_build_object('revaluationScan',true,'leagueId',v_scope.league_id,'seasonId',v_scope.league_season_id,
        'version',v_scope.version,'sourcePublication',true),v_scope.league_id);
    IF v_scan IS NOT NULL THEN
      UPDATE private.trade_revaluation_schedule schedule SET next_allowed_at=now()
        FROM public.trades trade WHERE trade.id=schedule.trade_id AND trade.league_season_id=v_scope.league_season_id
        AND trade.status IN ('pending','accepted');
    END IF;
  END LOOP;
  RETURN true;
END;
$$;
