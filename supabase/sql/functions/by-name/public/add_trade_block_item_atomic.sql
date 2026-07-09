-- Canonical SQL source for public.add_trade_block_item_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.add_trade_block_item_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id uuid;
  v_item_id uuid;
BEGIN
  IF ((p_player_id IS NOT NULL)::int + (p_pick_id IS NOT NULL)::int) <> 1 THEN
    RAISE EXCEPTION 'Trade block item must be exactly one player or pick.'
      USING ERRCODE = '22023';
  END IF;

  IF p_note IS NOT NULL AND length(p_note) > 280 THEN
    RAISE EXCEPTION 'Trade block notes must be 280 characters or fewer.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND (p_user_id IS NULL OR user_id = p_user_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
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

  IF p_player_id IS NOT NULL THEN
    PERFORM 1
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = v_season_id
       AND member_id = p_member_id
       AND player_id = p_player_id
       AND is_on_ir = false
       AND is_on_taxi = false
     FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only active roster players can be listed on the trade block.'
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO trade_block_items (
      league_id,
      member_id,
      player_id,
      note,
      updated_at
    )
    VALUES (
      p_league_id,
      p_member_id,
      p_player_id,
      NULLIF(BTRIM(COALESCE(p_note, '')), ''),
      now()
    )
    ON CONFLICT (league_id, member_id, player_id) WHERE player_id IS NOT NULL DO UPDATE
       SET note = EXCLUDED.note,
           updated_at = now()
    RETURNING id INTO v_item_id;
  ELSE
    PERFORM 1
      FROM draft_picks
     WHERE id = p_pick_id
       AND league_id = p_league_id
       AND current_owner_id = p_member_id
       AND is_used = false
     FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only picks you own can be listed on the trade block.'
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO trade_block_items (
      league_id,
      member_id,
      pick_id,
      note,
      updated_at
    )
    VALUES (
      p_league_id,
      p_member_id,
      p_pick_id,
      NULLIF(BTRIM(COALESCE(p_note, '')), ''),
      now()
    )
    ON CONFLICT (league_id, member_id, pick_id) WHERE pick_id IS NOT NULL DO UPDATE
       SET note = EXCLUDED.note,
           updated_at = now()
    RETURNING id INTO v_item_id;
  END IF;

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'trade_block_updated',
    'Trade block updated',
    NULL,
    p_member_id,
    NULL,
    p_player_id,
    NULL,
    NULL,
    jsonb_build_object('trade_block_item_id', v_item_id, 'pick_id', p_pick_id)
  );

  RETURN v_item_id;
END;
$$;
