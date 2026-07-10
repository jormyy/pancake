-- Canonical SQL source for public.commissioner_adjust_faab_balance_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.commissioner_adjust_faab_balance_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_balance int
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_season_id uuid;
  v_balance int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_balance IS NULL OR p_balance < 0 THEN
    RAISE EXCEPTION 'FAAB balance must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can adjust FAAB balances.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found.'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO faab_balances (
    league_id,
    league_season_id,
    member_id,
    balance
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_balance
  )
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
     SET balance = EXCLUDED.balance,
         updated_at = now()
  RETURNING balance INTO v_balance;

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'commissioner_faab_adjusted',
    'FAAB balance adjusted',
    NULL,
    NULL,
    p_member_id,
    NULL,
    NULL,
    NULL,
    jsonb_build_object('balance', v_balance)
  );

  RETURN v_balance;
END;
$$;
