-- Canonical SQL source for private.lock_trade_offer_assets.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.lock_trade_offer_assets(
  p_league_id uuid,
  p_member_ids uuid[],
  p_player_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Roster mutations take team locks, then player locks, before row locks.
  FOR v_id IN SELECT DISTINCT id FROM unnest(p_member_ids) AS id WHERE id IS NOT NULL ORDER BY id
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_id::text)) THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
    END IF;
  END LOOP;
  FOR v_id IN SELECT DISTINCT id FROM unnest(p_player_ids) AS id WHERE id IS NOT NULL ORDER BY id
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_id::text)) THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
    END IF;
  END LOOP;
END;
$$;
