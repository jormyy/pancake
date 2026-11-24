-- Canonical SQL source for private.request_lineup_refill.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.request_lineup_refill(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lineup_optimizer_settings s
      JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
      JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs') AND l.deleted_at IS NULL
     WHERE s.league_id = p_league_id AND s.league_season_id = p_league_season_id
       AND s.member_id = p_member_id AND s.enabled
  ) THEN RETURN; END IF;
  INSERT INTO private.lineup_refill_requests(member_id, league_id, league_season_id, requested_at)
  VALUES (p_member_id, p_league_id, p_league_season_id, clock_timestamp())
  ON CONFLICT (member_id) DO UPDATE SET league_id = EXCLUDED.league_id,
    league_season_id = EXCLUDED.league_season_id, requested_at = EXCLUDED.requested_at;
  PERFORM private.ensure_lineup_refill_queued();
END;
$$;
