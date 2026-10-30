-- Canonical SQL source for private.refresh_dispatch_screen_views.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.refresh_dispatch_screen_views()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id)
  SELECT season.league_id, season.id FROM public.league_seasons season
  JOIN public.leagues league ON league.id = season.league_id AND league.deleted_at IS NULL
  WHERE NOT EXISTS(SELECT 1 FROM private.screen_refresh_queue queued WHERE queued.league_season_id=season.id)
  ORDER BY season.id ON CONFLICT DO NOTHING;
  IF EXISTS (SELECT 1 FROM private.screen_refresh_queue WHERE dirty AND available_at <= now()
    AND (claimed_at IS NULL OR claimed_at < now() - interval '3 minutes')) THEN
    PERFORM public.invoke_edge_function('refresh-views');
  END IF;
END;
$$;
