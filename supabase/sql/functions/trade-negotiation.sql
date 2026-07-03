-- Canonical SQL source for trade negotiation.
-- Edit this file first, then copy changed function statements into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies the latest migration definitions still match.

CREATE OR REPLACE FUNCTION private.clear_trade_block_listing_on_inactive_roster()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_on_ir = true OR NEW.is_on_taxi = true THEN
    PERFORM private.clear_trade_block_listing_for_asset(
      NEW.league_id,
      NEW.member_id,
      NEW.player_id
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.create_trade_offer(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_recipient_member_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0,
  p_parent_trade_id uuid DEFAULT NULL,
  p_countered_from_trade_id uuid DEFAULT NULL,
  p_edited_from_trade_id uuid DEFAULT NULL,
  p_version int DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade_id uuid;
  v_offer_player_ids uuid[] := COALESCE(p_offer_player_ids, ARRAY[]::uuid[]);
  v_request_player_ids uuid[] := COALESCE(p_request_player_ids, ARRAY[]::uuid[]);
  v_offer_pick_ids uuid[] := COALESCE(p_offer_pick_ids, ARRAY[]::uuid[]);
  v_request_pick_ids uuid[] := COALESCE(p_request_pick_ids, ARRAY[]::uuid[]);
  v_offer_faab_amount int := COALESCE(p_offer_faab_amount, 0);
  v_request_faab_amount int := COALESCE(p_request_faab_amount, 0);
  v_rows int;
  v_league leagues%ROWTYPE;
  v_balance int;
BEGIN
  IF p_proposer_member_id = p_recipient_member_id THEN
    RAISE EXCEPTION 'You cannot trade with yourself.';
  END IF;

  IF v_offer_faab_amount < 0 OR v_request_faab_amount < 0 THEN
    RAISE EXCEPTION 'FAAB trade amounts must be non-negative integers.'
      USING ERRCODE = '22023';
  END IF;

  IF cardinality(v_offer_player_ids) + cardinality(v_offer_pick_ids) + (CASE WHEN v_offer_faab_amount > 0 THEN 1 ELSE 0 END) = 0 OR
     cardinality(v_request_player_ids) + cardinality(v_request_pick_ids) + (CASE WHEN v_request_faab_amount > 0 THEN 1 ELSE 0 END) = 0 THEN
    RAISE EXCEPTION 'A trade must include at least one asset on each side.';
  END IF;

  IF (SELECT count(*) FROM unnest(v_offer_player_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_offer_player_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate offered players are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_request_player_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_request_player_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate requested players are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_offer_pick_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_offer_pick_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate offered picks are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_request_pick_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_request_pick_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate requested picks are not allowed.';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Trades require an active or playoff season.';
  END IF;

  IF v_league.status IN ('active'::league_status, 'playoffs'::league_status)
     AND v_league.trade_deadline IS NOT NULL
     AND v_league.trade_deadline < (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'The trade deadline has passed. Trades reopen once the season''s finals are complete.';
  END IF;

  IF p_expires_at IS NOT NULL THEN
    IF p_expires_at <= now() THEN
      RAISE EXCEPTION 'Trade expiration must be in the future.'
        USING ERRCODE = '22023';
    END IF;

    IF v_league.status IN ('active'::league_status, 'playoffs'::league_status)
       AND v_league.trade_deadline IS NOT NULL
       AND (p_expires_at AT TIME ZONE 'America/New_York')::date > v_league.trade_deadline THEN
      RAISE EXCEPTION 'Trade expiration must be before the trade deadline.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF (v_offer_faab_amount > 0 OR v_request_faab_amount > 0) AND v_league.waiver_mode <> 'faab' THEN
    RAISE EXCEPTION 'FAAB can only be traded in FAAB waiver leagues.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id
     AND is_current = true
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_proposer_member_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposer not found.';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_recipient_member_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recipient not found.';
  END IF;

  WITH locked AS (
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_proposer_member_id
       AND player_id = ANY(v_offer_player_ids)
       AND is_on_ir = false
       AND is_on_taxi = false
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_offer_player_ids) THEN
    RAISE EXCEPTION 'Your offer includes a player that is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_recipient_member_id
       AND player_id = ANY(v_request_player_ids)
       AND is_on_ir = false
       AND is_on_taxi = false
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_request_player_ids) THEN
    RAISE EXCEPTION 'Your request includes a player that is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT id
      FROM draft_picks
     WHERE league_id = p_league_id
       AND current_owner_id = p_proposer_member_id
       AND is_used = false
       AND id = ANY(v_offer_pick_ids)
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_offer_pick_ids) THEN
    RAISE EXCEPTION 'Your offer includes a draft pick that is no longer owned by the expected team.';
  END IF;

  WITH locked AS (
    SELECT id
      FROM draft_picks
     WHERE league_id = p_league_id
       AND current_owner_id = p_recipient_member_id
       AND is_used = false
       AND id = ANY(v_request_pick_ids)
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_request_pick_ids) THEN
    RAISE EXCEPTION 'Your request includes a draft pick that is no longer owned by the expected team.';
  END IF;

  IF v_offer_faab_amount > 0 THEN
    v_balance := private.ensure_faab_balance(p_league_id, p_league_season_id, p_proposer_member_id);
    IF v_balance < v_offer_faab_amount THEN
      RAISE EXCEPTION 'Offered FAAB exceeds the proposer''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_request_faab_amount > 0 THEN
    v_balance := private.ensure_faab_balance(p_league_id, p_league_season_id, p_recipient_member_id);
    IF v_balance < v_request_faab_amount THEN
      RAISE EXCEPTION 'Requested FAAB exceeds the recipient''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO trades (
    league_id,
    league_season_id,
    proposer_member_id,
    recipient_member_id,
    notes,
    status,
    expires_at,
    parent_trade_id,
    countered_from_trade_id,
    edited_from_trade_id,
    version,
    proposer_faab_amount,
    recipient_faab_amount
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_recipient_member_id,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending',
    p_expires_at,
    p_parent_trade_id,
    p_countered_from_trade_id,
    p_edited_from_trade_id,
    GREATEST(COALESCE(p_version, 1), 1),
    v_offer_faab_amount,
    v_request_faab_amount
  )
  RETURNING id INTO v_trade_id;

  INSERT INTO trade_items (trade_id, side, player_id, pick_id)
  SELECT v_trade_id, 'proposer'::trade_side, player_id, NULL::uuid
    FROM unnest(v_offer_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, player_id, NULL::uuid
    FROM unnest(v_request_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'proposer'::trade_side, NULL::uuid, pick_id
    FROM unnest(v_offer_pick_ids) AS pick_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, NULL::uuid, pick_id
    FROM unnest(v_request_pick_ids) AS pick_id;

  PERFORM private.log_league_activity(
    p_league_id,
    p_league_season_id,
    CASE
      WHEN p_countered_from_trade_id IS NOT NULL THEN 'trade_countered'
      WHEN p_edited_from_trade_id IS NOT NULL THEN 'trade_edited'
      ELSE 'trade_offered'
    END,
    CASE
      WHEN p_countered_from_trade_id IS NOT NULL THEN 'Counteroffer sent'
      WHEN p_edited_from_trade_id IS NOT NULL THEN 'Trade offer edited'
      ELSE 'Trade offer sent'
    END,
    NULL,
    p_proposer_member_id,
    p_recipient_member_id,
    NULL,
    v_trade_id,
    NULL,
    jsonb_build_object(
      'parent_trade_id', p_parent_trade_id,
      'countered_from_trade_id', p_countered_from_trade_id,
      'edited_from_trade_id', p_edited_from_trade_id,
      'version', GREATEST(COALESCE(p_version, 1), 1),
      'proposer_faab_amount', v_offer_faab_amount,
      'recipient_faab_amount', v_request_faab_amount
    )
  );

  RETURN v_trade_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.propose_trade_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_recipient_member_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.create_trade_offer(
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_recipient_member_id,
    p_offer_player_ids,
    p_request_player_ids,
    p_offer_pick_ids,
    p_request_pick_ids,
    p_notes,
    p_expires_at,
    p_offer_faab_amount,
    p_request_faab_amount,
    NULL,
    NULL,
    NULL,
    1
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.replace_trade_offer(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_action text,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_new_trade_id uuid;
  v_parent_trade_id uuid;
  v_new_proposer_member_id uuid;
  v_new_recipient_member_id uuid;
  v_replaced_status trade_status;
  v_countered_from_trade_id uuid := NULL;
  v_edited_from_trade_id uuid := NULL;
  v_pending_error text;
  v_actor_error text;
BEGIN
  IF p_action NOT IN ('counter', 'edit') THEN
    RAISE EXCEPTION 'Unsupported trade replacement action.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_action = 'counter' THEN
    v_new_proposer_member_id := p_member_id;
    v_new_recipient_member_id := v_trade.proposer_member_id;
    v_replaced_status := 'countered'::trade_status;
    v_countered_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be countered.';
    v_actor_error := 'Only the recipient can counter this offer.';
  ELSE
    v_new_proposer_member_id := p_member_id;
    v_new_recipient_member_id := v_trade.recipient_member_id;
    v_replaced_status := 'edited'::trade_status;
    v_edited_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be edited.';
    v_actor_error := 'Only the proposer can edit this offer.';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION '%', v_pending_error
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;
    RETURN NULL;
  END IF;

  IF (
    (p_action = 'counter' AND v_trade.recipient_member_id <> p_member_id)
    OR (p_action = 'edit' AND v_trade.proposer_member_id <> p_member_id)
  ) THEN
    RAISE EXCEPTION '%', v_actor_error
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND user_id = p_user_id
     AND league_id = v_trade.league_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
  END IF;

  v_parent_trade_id := COALESCE(v_trade.parent_trade_id, v_trade.id);

  v_new_trade_id := private.create_trade_offer(
    v_trade.league_id,
    v_trade.league_season_id,
    v_new_proposer_member_id,
    v_new_recipient_member_id,
    p_offer_player_ids,
    p_request_player_ids,
    p_offer_pick_ids,
    p_request_pick_ids,
    p_notes,
    p_expires_at,
    p_offer_faab_amount,
    p_request_faab_amount,
    v_parent_trade_id,
    v_countered_from_trade_id,
    v_edited_from_trade_id,
    v_trade.version + 1
  );

  UPDATE trades
     SET status = v_replaced_status,
         replaced_by_trade_id = v_new_trade_id
   WHERE id = p_trade_id
     AND status = 'pending'::trade_status;

  RETURN v_new_trade_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.counter_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.replace_trade_offer(
    p_trade_id,
    p_member_id,
    p_user_id,
    'counter',
    p_offer_player_ids,
    p_request_player_ids,
    p_offer_pick_ids,
    p_request_pick_ids,
    p_notes,
    p_expires_at,
    p_offer_faab_amount,
    p_request_faab_amount
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.edit_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.replace_trade_offer(
    p_trade_id,
    p_member_id,
    p_user_id,
    'edit',
    p_offer_player_ids,
    p_request_player_ids,
    p_offer_pick_ids,
    p_request_pick_ids,
    p_notes,
    p_expires_at,
    p_offer_faab_amount,
    p_request_faab_amount
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_expired_or_unfunded_trade_accept()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_balance int;
BEGIN
  IF OLD.status = 'pending'::trade_status AND NEW.status = 'accepted'::trade_status THEN
    IF OLD.expires_at IS NOT NULL AND OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'This trade offer has expired.'
        USING ERRCODE = 'P0001';
    END IF;

    IF OLD.proposer_faab_amount > 0 THEN
      v_balance := private.ensure_faab_balance(OLD.league_id, OLD.league_season_id, OLD.proposer_member_id);
      IF v_balance < OLD.proposer_faab_amount THEN
        RAISE EXCEPTION 'Proposer no longer has enough FAAB for this trade.'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF OLD.recipient_faab_amount > 0 THEN
      v_balance := private.ensure_faab_balance(OLD.league_id, OLD.league_season_id, OLD.recipient_member_id);
      IF v_balance < OLD.recipient_faab_amount THEN
        RAISE EXCEPTION 'Recipient no longer has enough FAAB for this trade.'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_pending_trades_atomic(
  p_limit int DEFAULT 100
)
RETURNS TABLE (
  trade_id uuid,
  proposer_member_id uuid,
  recipient_member_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500);
BEGIN
  RETURN QUERY
  WITH expired AS (
    UPDATE trades AS trade
       SET status = 'expired'::trade_status
     WHERE trade.id IN (
       SELECT pending.id
         FROM trades AS pending
        WHERE pending.status = 'pending'::trade_status
          AND pending.expires_at IS NOT NULL
          AND pending.expires_at <= now()
        ORDER BY pending.expires_at, pending.proposed_at, pending.id
        LIMIT v_limit
        FOR UPDATE SKIP LOCKED
     )
     RETURNING trade.id, trade.league_id, trade.league_season_id, trade.proposer_member_id, trade.recipient_member_id
  ),
  logged AS (
    INSERT INTO league_activity (
      league_id,
      league_season_id,
      actor_member_id,
      target_member_id,
      related_trade_id,
      event_type,
      title
    )
    SELECT
      expired.league_id,
      expired.league_season_id,
      expired.proposer_member_id,
      expired.recipient_member_id,
      expired.id,
      'trade_expired',
      'Trade offer expired'
    FROM expired
    RETURNING id
  )
  SELECT expired.id, expired.proposer_member_id, expired.recipient_member_id
    FROM expired;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_accepted_trade_atomic(
  p_trade_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_drop trade_drop_reservations%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_clear_player_id uuid;
  v_rows int;
  v_active_count int;
  v_balance int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'accepted' THEN
    RAISE EXCEPTION 'Trade is not ready to complete';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at > now() THEN
    RAISE EXCEPTION 'Trade veto window is still open';
  END IF;

  FOR v_member_lock IN
    SELECT member_id
      FROM (
        VALUES (v_trade.proposer_member_id), (v_trade.recipient_member_id)
      ) AS members(member_id)
     ORDER BY member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member_lock::text));
  END LOOP;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM (
        SELECT player_id
          FROM trade_items
         WHERE trade_id = p_trade_id
           AND player_id IS NOT NULL
        UNION ALL
        SELECT player_id
          FROM trade_drop_reservations
         WHERE trade_id = p_trade_id
      ) AS touched
     WHERE player_id IS NOT NULL
     ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Trades require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_trade.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trades require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;

    IF v_item.player_id IS NOT NULL THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND is_on_ir = false
         AND is_on_taxi = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side'
          USING ERRCODE = 'PT001';
      END IF;
    END IF;
  END LOOP;

  IF v_trade.proposer_faab_amount > 0 THEN
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_trade.proposer_member_id);
    IF v_balance < v_trade.proposer_faab_amount THEN
      RAISE EXCEPTION 'Proposer no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END IF;

  IF v_trade.recipient_faab_amount > 0 THEN
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_trade.recipient_member_id);
    IF v_balance < v_trade.recipient_faab_amount THEN
      RAISE EXCEPTION 'Recipient no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END IF;

  FOR v_drop IN
    SELECT *
      FROM trade_drop_reservations
     WHERE trade_id = p_trade_id
     ORDER BY player_id ASC
     FOR UPDATE
  LOOP
    DELETE FROM trade_drop_reservations
     WHERE id = v_drop.id;

    PERFORM private.release_roster_player_to_waivers(
      v_drop.roster_player_id,
      v_trade.league_id,
      v_trade.league_season_id,
      v_drop.member_id,
      v_drop.player_id,
      'fa_drop',
      NULL,
      NULL,
      'Reserved drop player is no longer on the expected roster.'
    );
  END LOOP;

  FOR v_clear_player_id IN
    SELECT DISTINCT player_id
      FROM trade_items
     WHERE trade_id = p_trade_id
       AND player_id IS NOT NULL
     ORDER BY player_id
  LOOP
    PERFORM private.clear_future_unlocked_lineups(
      v_trade.league_id,
      v_trade.league_season_id,
      v_clear_player_id
    );
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;
    v_to_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.recipient_member_id
      ELSE v_trade.proposer_member_id
    END;

    IF v_item.player_id IS NOT NULL THEN
      UPDATE roster_players
         SET member_id = v_to_member,
             acquired_via = 'trade'
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND is_on_ir = false
         AND is_on_taxi = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move player asset atomically'
          USING ERRCODE = 'PT001';
      END IF;

      PERFORM private.clear_trade_block_listing_for_asset(
        v_trade.league_id,
        v_from_member,
        v_item.player_id
      );

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        related_trade_id
      )
      VALUES
        (v_trade.league_id, v_trade.league_season_id, v_from_member, v_item.player_id, 'trade_out', p_trade_id),
        (v_trade.league_id, v_trade.league_season_id, v_to_member, v_item.player_id, 'trade_in', p_trade_id);
    ELSE
      UPDATE draft_picks
         SET current_owner_id = v_to_member
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move draft-pick asset atomically'
          USING ERRCODE = 'PT001';
      END IF;

      PERFORM private.clear_trade_block_listing_for_asset(
        v_trade.league_id,
        v_from_member,
        NULL,
        v_item.pick_id
      );
    END IF;
  END LOOP;

  IF v_trade.proposer_faab_amount > 0 THEN
    UPDATE faab_balances
       SET balance = balance - v_trade.proposer_faab_amount,
           updated_at = now()
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_trade.proposer_member_id;

    INSERT INTO faab_balances (
      league_id,
      league_season_id,
      member_id,
      balance
    )
    VALUES (
      v_trade.league_id,
      v_trade.league_season_id,
      v_trade.recipient_member_id,
      v_trade.proposer_faab_amount
    )
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
       SET balance = faab_balances.balance + EXCLUDED.balance,
           updated_at = now();
  END IF;

  IF v_trade.recipient_faab_amount > 0 THEN
    UPDATE faab_balances
       SET balance = balance - v_trade.recipient_faab_amount,
           updated_at = now()
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_trade.recipient_member_id;

    INSERT INTO faab_balances (
      league_id,
      league_season_id,
      member_id,
      balance
    )
    VALUES (
      v_trade.league_id,
      v_trade.league_season_id,
      v_trade.proposer_member_id,
      v_trade.recipient_faab_amount
    )
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
       SET balance = faab_balances.balance + EXCLUDED.balance,
           updated_at = now();
  END IF;

  FOR v_to_member IN
    SELECT v_trade.proposer_member_id
    UNION
    SELECT v_trade.recipient_member_id
  LOOP
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_to_member
       AND is_on_ir = false
       AND is_on_taxi = false;

    IF v_active_count > COALESCE(v_league.roster_size, 0) THEN
      RAISE EXCEPTION 'Trade completion would overfill a roster.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  DELETE FROM trade_drop_reservations WHERE trade_id = p_trade_id;

  UPDATE trades
     SET status = 'completed',
         completed_at = now(),
         completion_failure_reason = NULL
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;

  PERFORM private.log_league_activity(
    v_trade.league_id,
    v_trade.league_season_id,
    'trade_completed',
    'Trade completed',
    NULL,
    v_trade.proposer_member_id,
    v_trade.recipient_member_id,
    NULL,
    p_trade_id,
    NULL,
    jsonb_build_object(
      'proposer_faab_amount', v_trade.proposer_faab_amount,
      'recipient_faab_amount', v_trade.recipient_faab_amount
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::public.trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.recipient_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the trade recipient can reject this trade.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.league_members AS member
   WHERE member.id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.trades
     SET status = 'rejected'::public.trade_status
   WHERE id = p_trade_id
     AND status = 'pending'::public.trade_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::public.trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.proposer_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the trade proposer can withdraw this trade.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.league_members AS member
   WHERE member.id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.trades
     SET status = 'withdrawn'::public.trade_status
   WHERE id = p_trade_id
     AND status = 'pending'::public.trade_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_due_accepted_trades_atomic(
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  trade_id uuid,
  proposer_member_id uuid,
  recipient_member_id uuid,
  status text,
  error_code text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 0), 200);
  v_trade record;
  v_error_code text;
  v_error_message text;
BEGIN
  FOR v_trade IN
    SELECT
      trade.id,
      trade.proposer_member_id,
      trade.recipient_member_id
    FROM public.trades AS trade
    JOIN public.league_seasons AS season
      ON season.id = trade.league_season_id
    JOIN public.leagues AS league
      ON league.id = trade.league_id
    WHERE trade.status = 'accepted'::public.trade_status
      AND trade.veto_window_expires_at <= now()
      AND season.is_current = true
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status)
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
    LIMIT v_limit
    FOR UPDATE OF trade SKIP LOCKED
  LOOP
    BEGIN
      PERFORM public.complete_accepted_trade_atomic(v_trade.id);

      RETURN QUERY
      SELECT
        v_trade.id,
        v_trade.proposer_member_id,
        v_trade.recipient_member_id,
        'completed'::text,
        NULL::text,
        NULL::text;
    EXCEPTION WHEN OTHERS THEN
      v_error_code := SQLSTATE;
      v_error_message := SQLERRM;

      IF v_error_code = 'PT001' THEN
        PERFORM public.expire_trade_completion_failure_atomic(v_trade.id, v_error_message);

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          'expired_terminal_failure'::text,
          v_error_code,
          v_error_message;
      ELSE
        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          'failed_retryable'::text,
          v_error_code,
          v_error_message;
      END IF;
    END;
  END LOOP;
END;
$$;

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
