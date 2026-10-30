-- Canonical SQL source for private.taxi_start_year.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.taxi_start_year(p_league_id uuid,p_player_id uuid,p_fallback int)
RETURNS int LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT COALESCE(min(start_year),p_fallback) FROM (
    SELECT COALESCE(roster.taxi_start_season_year,season.season_year) AS start_year
    FROM roster_players roster JOIN league_seasons season ON season.id=roster.league_season_id
    WHERE roster.league_id=p_league_id AND roster.player_id=p_player_id
      AND (roster.is_on_taxi OR roster.taxi_start_season_year IS NOT NULL)
    UNION ALL
    SELECT season.season_year FROM roster_transactions history JOIN league_seasons season ON season.id=history.league_season_id
    WHERE history.league_id=p_league_id AND history.player_id=p_player_id
      AND (history.acquired_to_taxi OR history.transaction_type='taxi_designate')
  ) placements;
$$;
