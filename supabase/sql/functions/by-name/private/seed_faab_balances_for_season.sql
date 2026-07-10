-- Canonical SQL source for private.seed_faab_balances_for_season.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.seed_faab_balances_for_season()
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
    NEW.id,
    member.id,
    league.faab_starting_budget
  FROM league_members AS member
  JOIN leagues AS league ON league.id = member.league_id
  WHERE member.league_id = NEW.league_id
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
     SET balance = EXCLUDED.balance,
         updated_at = now();

  RETURN NEW;
END;
$$;
