-- Canonical SQL source for public.create_auction_nomination_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.create_auction_nomination_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_user_id uuid,
  p_countdown_seconds int DEFAULT NULL
)
RETURNS nominations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_nomination nominations%ROWTYPE;
  v_order_count int;
  v_expected_member_id uuid;
  v_nomination_order int;
  v_countdown_seconds int;
BEGIN
  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  v_countdown_seconds := COALESCE(p_countdown_seconds, v_draft.pick_timer_seconds, 30);
  IF v_countdown_seconds < 5 OR v_countdown_seconds > 3600 THEN
    RAISE EXCEPTION 'Countdown seconds must be between 5 and 3600';
  END IF;

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM league_members
     WHERE id = p_member_id
       AND league_id = v_draft.league_id
       AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to act for this member'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(p_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(p_player_id::text)
  );

  IF v_draft.status <> 'in_progress'::draft_status THEN
    RAISE EXCEPTION 'Draft is not in progress';
  END IF;

  SELECT count(*)
    INTO v_order_count
    FROM draft_orders
   WHERE draft_id = p_draft_id;

  IF v_order_count <= 0 THEN
    RAISE EXCEPTION 'No draft order found';
  END IF;

  SELECT member_id
    INTO v_expected_member_id
    FROM draft_orders
   WHERE draft_id = p_draft_id
     AND position = (((v_draft.current_nomination_order - 1) % v_order_count) + 1);

  IF v_expected_member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION 'It is not your turn to nominate';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM nominations
     WHERE draft_id = p_draft_id
       AND status = 'open'::nomination_status
  ) THEN
    RAISE EXCEPTION 'A nomination is already open - wait for it to close';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM nominations
     WHERE draft_id = p_draft_id
       AND player_id = p_player_id
  ) THEN
    RAISE EXCEPTION 'Player already nominated in this draft';
  END IF;

  IF NOT v_draft.is_mock AND EXISTS (
    SELECT 1
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = p_player_id
  ) THEN
    RAISE EXCEPTION 'Player is already rostered';
  END IF;

  SELECT count(*) + 1
    INTO v_nomination_order
    FROM nominations
   WHERE draft_id = p_draft_id;

  INSERT INTO nominations (
    draft_id,
    nominating_member_id,
    player_id,
    nomination_order,
    status,
    current_bid_amount,
    current_bidder_id,
    countdown_expires_at
  )
  VALUES (
    p_draft_id,
    p_member_id,
    p_player_id,
    v_nomination_order,
    'open',
    0,
    NULL,
    now() + make_interval(secs => v_countdown_seconds)
  )
  RETURNING * INTO v_nomination;

  RETURN v_nomination;
END;
$$;
