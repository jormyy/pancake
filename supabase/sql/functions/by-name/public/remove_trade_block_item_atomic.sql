-- Canonical SQL source for public.remove_trade_block_item_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.remove_trade_block_item_atomic(
  p_item_id uuid,
  p_member_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item trade_block_items%ROWTYPE;
  v_season_id uuid;
BEGIN
  SELECT *
    INTO v_item
    FROM trade_block_items
   WHERE id = p_item_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_item.member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the listing manager can remove this trade block item.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_item.league_id
     AND (p_user_id IS NULL OR user_id = p_user_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = v_item.league_id
     AND is_current = true
   LIMIT 1;

  DELETE FROM trade_block_items
   WHERE id = p_item_id;

  PERFORM private.log_league_activity(
    v_item.league_id,
    v_season_id,
    'trade_block_updated',
    'Trade block updated',
    'An item was removed from the trade block.',
    p_member_id,
    NULL,
    v_item.player_id,
    NULL,
    NULL,
    jsonb_build_object('pick_id', v_item.pick_id)
  );
END;
$$;
