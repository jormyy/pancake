-- Canonical SQL source for private.begin_trade_offer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.begin_trade_offer(
  p_member_id uuid,
  p_user_id uuid,
  p_member_ids uuid[],
  p_player_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_league_id uuid;
  v_member_id uuid;
  v_player_id uuid;
BEGIN
  SELECT league_id INTO v_league_id FROM league_members WHERE id = p_member_id AND user_id = p_user_id;
  IF p_user_id IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.' USING ERRCODE = '42501';
  END IF;

  FOR v_member_id IN SELECT DISTINCT id FROM unnest(p_member_id || p_member_ids) AS id WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_league_id::text), hashtext(v_member_id::text));
  END LOOP;
  FOR v_player_id IN SELECT DISTINCT id FROM unnest(p_player_ids) AS id WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_league_id::text), hashtext(v_player_id::text));
  END LOOP;

  PERFORM 1 FROM league_members WHERE id = p_member_id AND user_id = p_user_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.' USING ERRCODE = '42501';
  END IF;
  RETURN v_league_id;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE = 'PA010';
END;
$$;
