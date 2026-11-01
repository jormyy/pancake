-- Canonical SQL source for private.refresh_queue_screen_views.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.refresh_queue_screen_views(p_league_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.screen_refresh_queue AS queued(league_id, league_season_id)
  SELECT season.league_id, season.id FROM public.league_seasons season
  JOIN public.leagues league ON league.id = season.league_id AND league.deleted_at IS NULL
  WHERE p_league_id IS NULL OR season.league_id = p_league_id
  ORDER BY season.id
  ON CONFLICT (league_season_id) DO UPDATE SET version = queued.version + 1,
    dirty = true, changed_at = now(), available_at = GREATEST(COALESCE(queued.last_refreshed_at,'-infinity'::timestamptz)+interval '2 minutes',now())
  WHERE NOT queued.dirty OR queued.claimed_at IS NOT NULL AND queued.changed_at IS DISTINCT FROM now();
$$;
