-- Canonical SQL source for private.matchup_forecast_refresh_pending.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.matchup_forecast_refresh_pending(p_matchup_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM public.matchups matchup JOIN private.forecast_refresh_requests requested
    ON requested.scope IN('all','league:'||matchup.league_id,'matchup:'||matchup.id)
    WHERE matchup.id=p_matchup_id AND requested.available_at<=now());
$$;
