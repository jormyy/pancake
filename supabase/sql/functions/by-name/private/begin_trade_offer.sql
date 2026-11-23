-- Canonical SQL source for private.begin_trade_offer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.begin_trade_offer(p_member_id uuid, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_league_id uuid;
BEGIN
  SELECT league_id INTO v_league_id FROM league_members WHERE id = p_member_id AND user_id = p_user_id;
  IF p_user_id IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.' USING ERRCODE = '42501';
  END IF;
  RETURN v_league_id;
END;
$$;
