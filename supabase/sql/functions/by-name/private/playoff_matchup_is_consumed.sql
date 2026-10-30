-- Canonical SQL source for private.playoff_matchup_is_consumed.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.playoff_matchup_is_consumed(p_matchup_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT CASE WHEN current.playoff_round IS NULL THEN
    private.playoff_round_is_consumed(current.league_season_id,current.matchup_type)
  ELSE EXISTS (SELECT 1 FROM matchups later WHERE later.league_season_id=current.league_season_id
    AND later.playoff_round>current.playoff_round)
    OR (current.matchup_type='playoff_final' AND EXISTS (SELECT 1 FROM league_seasons
      WHERE id=current.league_season_id AND NOT is_current)) END
  FROM matchups current WHERE current.id=p_matchup_id;
$$;
