CREATE OR REPLACE FUNCTION private.queue_matchup_forecasts(p_league_id uuid DEFAULT NULL,p_matchup_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  INSERT INTO private.forecast_refresh_requests AS requested(scope,league_id,matchup_id,available_at)
  SELECT CASE WHEN p_matchup_id IS NOT NULL THEN 'matchup:'||p_matchup_id
    WHEN p_league_id IS NOT NULL THEN 'league:'||p_league_id ELSE 'all' END,p_league_id,p_matchup_id,now()
  WHERE (p_league_id IS NULL OR EXISTS(SELECT 1 FROM public.leagues WHERE id=p_league_id))
    AND (p_matchup_id IS NULL OR EXISTS(SELECT 1 FROM public.matchups WHERE id=p_matchup_id))
  ON CONFLICT(scope) DO UPDATE SET revision=requested.revision+1,after_matchup_id=NULL,available_at=LEAST(requested.available_at,EXCLUDED.available_at);
$$;
