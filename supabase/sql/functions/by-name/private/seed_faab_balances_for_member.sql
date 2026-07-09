-- Canonical SQL source for private.seed_faab_balances_for_member.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.seed_faab_balances_for_member()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO faab_balances (
    league_id,
    league_season_id,
    member_id,
    balance
  )
  SELECT
    NEW.league_id,
    season.id,
    NEW.id,
    league.faab_starting_budget
  FROM league_seasons AS season
  JOIN leagues AS league ON league.id = season.league_id
  WHERE season.league_id = NEW.league_id
    AND season.is_current = true
  ON CONFLICT (league_id, league_season_id, member_id) DO NOTHING;

  RETURN NEW;
END;
$$;
