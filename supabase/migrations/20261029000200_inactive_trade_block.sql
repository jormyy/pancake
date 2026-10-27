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
       AND ((is_on_ir = false AND is_on_taxi = false)
         OR EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades))
     FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only players you own can be listed. This league must permit inactive-player trades for IR or taxi listings.'
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

CREATE OR REPLACE FUNCTION private.sync_roster_linked_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_left_roster boolean := TG_OP = 'DELETE' OR OLD.member_id IS DISTINCT FROM NEW.member_id;
  v_cancel_claims boolean;
  v_became_inactive boolean := TG_OP = 'UPDATE'
    AND (NEW.is_on_ir = true OR NEW.is_on_taxi = true)
    AND (OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi);
BEGIN
  IF NOT (v_left_roster OR v_became_inactive) THEN
    RETURN NULL;
  END IF;

  -- An old-season row going away never touches live state.
  IF NOT EXISTS (SELECT 1 FROM league_seasons WHERE id = OLD.league_season_id AND is_current = true) THEN
    RETURN NULL;
  END IF;


  PERFORM private.clear_future_unlocked_lineups(
    OLD.league_id,
    OLD.league_season_id,
    OLD.player_id,
    OLD.member_id
  );

  IF v_left_roster THEN
    DELETE FROM trade_block_items
     WHERE league_id = OLD.league_id
       AND member_id = OLD.member_id
       AND player_id = OLD.player_id;

    v_cancel_claims := private.trade_lifecycle_write_active()
      AND EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id AND allow_inactive_trades);
    IF v_cancel_claims THEN
      WITH changed_claims AS (
        UPDATE waiver_claims
           SET status = 'cancelled',
               failure_reason = 'The selected drop player left this roster in another transaction.',
               processed_at = now(),
               drop_player_id = NULL
         WHERE status = 'pending'
           AND league_id = OLD.league_id
           AND league_season_id = OLD.league_season_id
           AND member_id = OLD.member_id
           AND drop_player_id = OLD.player_id
         RETURNING id, member_id, failure_reason
      )
      INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
      SELECT 'trade_claim_cancelled:'||id,member_id,'trade_claim_cancelled','Waiver claim cancelled',failure_reason,
        jsonb_build_object('claimId',id),'trade'
      FROM changed_claims
      ON CONFLICT (dedupe_key) DO NOTHING;
    ELSE
      UPDATE waiver_claims
         SET drop_player_id = NULL
       WHERE status = 'pending'
         AND league_id = OLD.league_id
         AND league_season_id = OLD.league_season_id
         AND member_id = OLD.member_id
         AND drop_player_id = OLD.player_id;
    END IF;

    PERFORM private.expire_pending_trades_for_lost_asset(
      OLD.league_id,
      OLD.member_id,
      OLD.player_id
    );
  END IF;

  RETURN NULL;
END;
$$;
