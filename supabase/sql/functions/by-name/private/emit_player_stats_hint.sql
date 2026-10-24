-- Canonical SQL source for private.emit_player_stats_hint.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.emit_player_stats_hint(p_years integer[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.player_stats_hint_pending(league_id)
  SELECT league.id FROM public.leagues league
   WHERE league.deleted_at IS NULL AND league.status IN ('active','playoffs')
     AND EXISTS(SELECT 1 FROM public.league_seasons season
       WHERE season.league_id=league.id AND season.is_current AND season.season_year=ANY(p_years))
   ORDER BY league.id
  ON CONFLICT DO NOTHING;
END;
$$;
