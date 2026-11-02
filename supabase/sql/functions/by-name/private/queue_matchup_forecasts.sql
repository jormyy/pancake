-- Canonical SQL source for private.queue_matchup_forecasts.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.queue_matchup_forecasts(p_league_id uuid DEFAULT NULL,p_matchup_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  INSERT INTO private.forecast_refresh_requests AS requested(scope,league_id,matchup_id,available_at)
  SELECT CASE WHEN p_matchup_id IS NOT NULL THEN 'matchup:'||p_matchup_id
    WHEN p_league_id IS NOT NULL THEN 'league:'||p_league_id ELSE 'all' END,p_league_id,p_matchup_id,min(due.due_at)
  FROM public.matchups matchup
  JOIN private.matchup_forecast_schedule due ON due.matchup_id=matchup.id
  WHERE (p_league_id IS NULL OR matchup.league_id=p_league_id)
    AND (p_matchup_id IS NULL OR matchup.id=p_matchup_id)
  HAVING min(due.due_at) IS NOT NULL
  ON CONFLICT(scope) DO UPDATE SET revision=requested.revision+1,after_matchup_id=NULL,available_at=EXCLUDED.available_at
    WHERE requested.available_at>EXCLUDED.available_at;
$$;
