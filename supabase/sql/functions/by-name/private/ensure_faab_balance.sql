-- Canonical SQL source for private.ensure_faab_balance.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.ensure_faab_balance(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS int
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_balance int;
  v_starting_budget int;
BEGIN
  SELECT balance
    INTO v_balance
    FROM faab_balances
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id
   FOR UPDATE;

  IF FOUND THEN
    RETURN v_balance;
  END IF;

  SELECT faab_starting_budget
    INTO v_starting_budget
    FROM leagues
   WHERE id = p_league_id;

  INSERT INTO faab_balances (
    league_id,
    league_season_id,
    member_id,
    balance
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_member_id,
    COALESCE(v_starting_budget, 100)
  )
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
     SET updated_at = now()
  RETURNING balance INTO v_balance;

  RETURN v_balance;
END;
$$;
