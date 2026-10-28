CREATE OR REPLACE FUNCTION public.complete_pick_prediction_refresh(p_source_version text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM private.trade_value_sync_state WHERE id AND content_sha256=p_source_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM public.draft_picks pick WHERE pick.round BETWEEN 1 AND 3
    AND EXISTS(SELECT 1 FROM public.league_seasons WHERE league_id=pick.league_id)
    AND pick.prediction_source_sha256 IS DISTINCT FROM p_source_version) THEN
    RAISE EXCEPTION 'Every league pick must refresh before trade re-analysis.' USING ERRCODE='40001';
  END IF;
  PERFORM public.queue_trade_estimate_reanalysis('onenumber-trade-v1-picks-v1');
  RETURN true;
END;
$$;
