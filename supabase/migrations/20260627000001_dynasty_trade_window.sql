-- Dynasty trade window.
-- Trading is allowed unless the league is mid-season past the trade deadline.

CREATE OR REPLACE FUNCTION public.propose_trade_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_recipient_member_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade_id uuid;
  v_offer_player_ids uuid[] := COALESCE(p_offer_player_ids, ARRAY[]::uuid[]);
  v_request_player_ids uuid[] := COALESCE(p_request_player_ids, ARRAY[]::uuid[]);
  v_offer_pick_ids uuid[] := COALESCE(p_offer_pick_ids, ARRAY[]::uuid[]);
  v_request_pick_ids uuid[] := COALESCE(p_request_pick_ids, ARRAY[]::uuid[]);
  v_rows int;
BEGIN
  IF p_proposer_member_id = p_recipient_member_id THEN
    RAISE EXCEPTION 'You cannot trade with yourself.';
  END IF;

  IF cardinality(v_offer_player_ids) + cardinality(v_offer_pick_ids) = 0 OR
     cardinality(v_request_player_ids) + cardinality(v_request_pick_ids) = 0 THEN
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

  PERFORM 1
    FROM leagues
   WHERE id = p_league_id
     AND status IN ('drafting', 'active', 'playoffs', 'offseason')
     AND NOT (
           status IN ('active', 'playoffs')
       AND trade_deadline IS NOT NULL
       AND trade_deadline < (now() AT TIME ZONE 'America/New_York')::date
     )
   FOR SHARE;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
        FROM leagues
       WHERE id = p_league_id
         AND status IN ('active', 'playoffs')
         AND trade_deadline IS NOT NULL
         AND trade_deadline < (now() AT TIME ZONE 'America/New_York')::date
    ) THEN
      RAISE EXCEPTION 'The trade deadline has passed. Trades reopen once the season''s finals are complete.';
    ELSE
      RAISE EXCEPTION 'Trades are not allowed for this league right now.';
    END IF;
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
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_offer_player_ids) THEN
    RAISE EXCEPTION 'Your offer includes a player that is no longer owned by the expected team.';
  END IF;

  WITH locked AS (
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_recipient_member_id
       AND player_id = ANY(v_request_player_ids)
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_request_player_ids) THEN
    RAISE EXCEPTION 'Your request includes a player that is no longer owned by the expected team.';
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

  INSERT INTO trades (
    league_id,
    league_season_id,
    proposer_member_id,
    recipient_member_id,
    notes,
    status
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_recipient_member_id,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending'
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

  RETURN v_trade_id;
END;
$$;

REVOKE ALL ON FUNCTION public.propose_trade_atomic(
  uuid, uuid, uuid, uuid, uuid[], uuid[], uuid[], uuid[], text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.propose_trade_atomic(
  uuid, uuid, uuid, uuid, uuid[], uuid[], uuid[], uuid[], text
) TO service_role;
