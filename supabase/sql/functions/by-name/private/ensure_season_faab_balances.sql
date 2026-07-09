-- Canonical SQL source for private.ensure_season_faab_balances.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.ensure_season_faab_balances(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO faab_balances (
    league_id,
    league_season_id,
    member_id,
    balance
  )
  SELECT
    member.league_id,
    p_league_season_id,
    member.id,
    league.faab_starting_budget
  FROM league_members AS member
  JOIN leagues AS league ON league.id = member.league_id
  WHERE member.league_id = p_league_id
  ON CONFLICT (league_id, league_season_id, member_id) DO NOTHING;
$$;
