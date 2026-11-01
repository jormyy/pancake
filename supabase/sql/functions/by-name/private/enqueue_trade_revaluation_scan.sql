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
    ((CASE WHEN (now() AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (now() AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT EXISTS(SELECT 1 FROM public.nba_games WHERE status='InProgress') THEN now() ELSE private.trade_revaluation_next_change() END) AT TIME ZONE 'America/New_York')::date::text,(CASE WHEN (now() AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (now() AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT EXISTS(SELECT 1 FROM public.nba_games WHERE status='InProgress') THEN now() ELSE private.trade_revaluation_next_change() END),
    jsonb_build_object('revaluationScan',true,'leagueId',selected_league,'seasonId',p_season_id,'version',p_version),selected_league) IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.enqueue_trade_revaluation_scan(uuid,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
