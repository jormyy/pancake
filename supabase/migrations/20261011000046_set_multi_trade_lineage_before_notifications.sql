BEGIN;

DROP FUNCTION private.create_multi_team_trade_offer(uuid,uuid,uuid,uuid[],jsonb,text,timestamptz);

-- Canonical SQL source for private.create_multi_team_trade_offer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.create_multi_team_trade_offer(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
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
  v_league leagues%ROWTYPE;
  v_rows int;
  v_participant_count int;
  v_first_recipient_member_id uuid;
  v_balance int;
  v_faab record;
  v_champion_finalized boolean := false;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Multi-team trade items must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'A multi-team trade must include between 1 and 100 items.'
      USING ERRCODE = '22023';
  END IF;

  IF octet_length(COALESCE(p_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'Trade notes must not exceed 2000 bytes.'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*)
    INTO v_participant_count
    FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids);
  IF v_participant_count < 3 THEN
    RAISE EXCEPTION 'A multi-team trade requires at least 3 teams.'
      USING ERRCODE = '22023';
  END IF;

  IF v_participant_count > 12 THEN
    RAISE EXCEPTION 'A multi-team trade cannot include more than 12 teams.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.parse_multi_team_trade_items(p_items)
     WHERE from_member_id = to_member_id
        OR faab_amount < 0
        OR ((player_id IS NOT NULL)::int + (pick_id IS NOT NULL)::int + (faab_amount > 0)::int) <> 1
  ) THEN
    RAISE EXCEPTION 'Each multi-team trade item must route exactly one player, pick, or positive FAAB amount between two different teams.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.parse_multi_team_trade_items(p_items) AS item
     WHERE NOT EXISTS (
       SELECT 1 FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant WHERE participant.member_id = item.from_member_id
     )
        OR NOT EXISTS (
       SELECT 1 FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant WHERE participant.member_id = item.to_member_id
     )
  ) THEN
    RAISE EXCEPTION 'Every item source and destination must be a trade participant.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant
     WHERE NOT EXISTS (
       SELECT 1
         FROM private.parse_multi_team_trade_items(p_items) AS item
        WHERE item.from_member_id = participant.member_id
           OR item.to_member_id = participant.member_id
     )
  ) THEN
    RAISE EXCEPTION 'Every participating team must send or receive at least one asset.'
      USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(player_id) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) <>
     (SELECT count(DISTINCT player_id) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Duplicate traded players are not allowed.';
  END IF;

  IF (SELECT count(pick_id) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) <>
     (SELECT count(DISTINCT pick_id) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Duplicate traded picks are not allowed.';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM matchups AS matchup
      JOIN league_seasons AS season
        ON season.id = matchup.league_season_id
       AND season.is_current = true
     WHERE matchup.league_id = p_league_id
       AND matchup.matchup_type = 'playoff_final'::matchup_type
       AND matchup.is_finalized = true
       AND matchup.winner_member_id IS NOT NULL
  )
    INTO v_champion_finalized;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.';
  END IF;

  IF v_league.status NOT IN (
    'setup'::league_status,
    'drafting'::league_status,
    'active'::league_status,
    'playoffs'::league_status,
    'offseason'::league_status
  ) THEN
    RAISE EXCEPTION 'Trades are not allowed for this league right now.';
  END IF;

  IF v_league.trade_deadline IS NOT NULL
     AND v_league.trade_deadline < (now() AT TIME ZONE 'America/New_York')::date THEN
    IF v_league.status = 'active'::league_status
       OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized) THEN
      RAISE EXCEPTION 'Trades are locked from the trade deadline until the champion is finalized.';
    END IF;
  END IF;

  IF p_expires_at IS NOT NULL THEN
    IF p_expires_at <= now() THEN
      RAISE EXCEPTION 'Trade expiration must be in the future.'
        USING ERRCODE = '22023';
    END IF;

    IF (v_league.status = 'active'::league_status
        OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized))
       AND v_league.trade_deadline IS NOT NULL
       AND (p_expires_at AT TIME ZONE 'America/New_York')::date > v_league.trade_deadline THEN
      RAISE EXCEPTION 'Trade expiration must be before the trade deadline.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM private.parse_multi_team_trade_items(p_items) WHERE faab_amount > 0)
     AND v_league.waiver_mode <> 'faab' THEN
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

  SELECT count(*)
    INTO v_rows
    FROM league_members AS member
    JOIN private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant
      ON participant.member_id = member.id
   WHERE member.league_id = p_league_id;

  IF v_rows <> v_participant_count THEN
    RAISE EXCEPTION 'Every trade participant must be a member of this league.';
  END IF;

  WITH locked AS (
    SELECT item.player_id
      FROM private.parse_multi_team_trade_items(p_items) AS item
      JOIN roster_players AS roster
        ON roster.league_id = p_league_id
       AND roster.league_season_id = p_league_season_id
       AND roster.member_id = item.from_member_id
       AND roster.player_id = item.player_id
       AND roster.is_on_ir = false
       AND roster.is_on_taxi = false
     WHERE item.player_id IS NOT NULL
     FOR SHARE OF roster
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> (SELECT count(*) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A player asset is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT item.pick_id
      FROM private.parse_multi_team_trade_items(p_items) AS item
      JOIN draft_picks AS pick
        ON pick.id = item.pick_id
       AND pick.league_id = p_league_id
       AND pick.current_owner_id = item.from_member_id
       AND pick.is_used = false
     WHERE item.pick_id IS NOT NULL
     FOR SHARE OF pick
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> (SELECT count(*) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A draft pick asset is no longer owned by the expected team.';
  END IF;

  FOR v_faab IN
    SELECT from_member_id, sum(faab_amount)::int AS amount
      FROM private.parse_multi_team_trade_items(p_items)
     WHERE faab_amount > 0
     GROUP BY from_member_id
  LOOP
    v_balance := private.ensure_faab_balance(p_league_id, p_league_season_id, v_faab.from_member_id);
    IF v_balance < v_faab.amount THEN
      RAISE EXCEPTION 'Offered FAAB exceeds a participant''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT member_id
    INTO v_first_recipient_member_id
    FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids)
   WHERE member_id <> p_proposer_member_id
   ORDER BY sort_order, member_id
   LIMIT 1;

  INSERT INTO trades (
    league_id,
    league_season_id,
    proposer_member_id,
    recipient_member_id,
    notes,
    status,
    expires_at,
    is_multi_team,
    parent_trade_id,
    countered_from_trade_id,
    edited_from_trade_id,
    version
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    v_first_recipient_member_id,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending',
    p_expires_at,
    true,
    p_parent_trade_id,
    p_countered_from_trade_id,
    p_edited_from_trade_id,
    p_version
  )
  RETURNING id INTO v_trade_id;

  INSERT INTO trade_participants (
    trade_id,
    member_id,
    sort_order,
    is_initiator,
    accepted_at
  )
  SELECT
    v_trade_id,
    member_id,
    sort_order,
    member_id = p_proposer_member_id,
    CASE WHEN member_id = p_proposer_member_id THEN now() ELSE NULL END
  FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids)
  ORDER BY sort_order, member_id;

  INSERT INTO trade_items (
    trade_id,
    side,
    player_id,
    pick_id,
    from_member_id,
    to_member_id,
    faab_amount
  )
  SELECT
    v_trade_id,
    CASE WHEN from_member_id = p_proposer_member_id THEN 'proposer'::trade_side ELSE 'recipient'::trade_side END,
    player_id,
    pick_id,
    from_member_id,
    to_member_id,
    faab_amount
  FROM private.parse_multi_team_trade_items(p_items)
  ORDER BY sort_order;

  PERFORM private.log_league_activity(
    p_league_id,
    p_league_season_id,
    'trade_offered',
    'Multi-team trade offer sent',
    NULL,
    p_proposer_member_id,
    v_first_recipient_member_id,
    NULL,
    v_trade_id,
    NULL,
    jsonb_build_object(
      'is_multi_team', true,
      'participant_count', v_participant_count,
      'item_count', jsonb_array_length(p_items)
    )
  );

  RETURN v_trade_id;
END;
$$;

REVOKE ALL ON FUNCTION private.create_multi_team_trade_offer(uuid,uuid,uuid,uuid[],jsonb,text,timestamptz,uuid,uuid,uuid,int) FROM PUBLIC, anon, authenticated, service_role;

-- Canonical SQL source for private.replace_multi_team_trade_offer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.replace_multi_team_trade_offer(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_action text,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_new_trade trades%ROWTYPE;
  v_new_trade_id uuid;
  v_parent_trade_id uuid;
  v_new_proposer_member_id uuid;
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

  IF COALESCE(v_trade.is_multi_team, false) = false THEN
    RAISE EXCEPTION 'This action only supports multi-team trades.'
      USING ERRCODE = '22023';
  END IF;

  IF p_action = 'counter' THEN
    v_new_proposer_member_id := p_member_id;
    v_replaced_status := 'countered'::trade_status;
    v_countered_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be countered.';
    v_actor_error := 'Only a non-proposer trade participant can counter this offer.';
  ELSE
    v_new_proposer_member_id := p_member_id;
    v_replaced_status := 'edited'::trade_status;
    v_edited_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be edited.';
    v_actor_error := 'Only the proposer can edit this offer.';
  END IF;


  IF p_action = 'counter' THEN
    IF v_trade.proposer_member_id = p_member_id OR NOT EXISTS (
      SELECT 1
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
         AND participant.member_id = p_member_id
         AND participant.accepted_at IS NULL
    ) THEN
      RAISE EXCEPTION '%', v_actor_error
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_trade.proposer_member_id <> p_member_id THEN
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

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION '%', v_pending_error
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;
    RETURN NULL;
  END IF;

  v_parent_trade_id := COALESCE(v_trade.parent_trade_id, v_trade.id);

  v_new_trade_id := private.create_multi_team_trade_offer(
    v_trade.league_id,
    v_trade.league_season_id,
    v_new_proposer_member_id,
    p_participant_member_ids,
    p_items,
    p_notes,
    p_expires_at,
    v_parent_trade_id,
    v_countered_from_trade_id,
    v_edited_from_trade_id,
    v_trade.version + 1
  );

  SELECT * INTO v_new_trade FROM trades WHERE id = v_new_trade_id;

  DELETE FROM league_activity
   WHERE related_trade_id = v_new_trade_id
     AND event_type = 'trade_offered';

  PERFORM private.log_league_activity(
    v_trade.league_id,
    v_trade.league_season_id,
    CASE
      WHEN v_countered_from_trade_id IS NOT NULL THEN 'trade_countered'
      ELSE 'trade_edited'
    END,
    CASE
      WHEN v_countered_from_trade_id IS NOT NULL THEN 'Multi-team counteroffer sent'
      ELSE 'Multi-team trade offer edited'
    END,
    NULL,
    v_new_trade.proposer_member_id,
    v_new_trade.recipient_member_id,
    NULL,
    v_new_trade_id,
    NULL,
    jsonb_build_object(
      'is_multi_team', true,
      'parent_trade_id', v_parent_trade_id,
      'countered_from_trade_id', v_countered_from_trade_id,
      'edited_from_trade_id', v_edited_from_trade_id,
      'version', v_trade.version + 1
    )
  );

  UPDATE trades
     SET status = v_replaced_status,
         replaced_by_trade_id = v_new_trade_id
   WHERE id = p_trade_id
     AND status = 'pending'::trade_status;

  RETURN v_new_trade_id;
END;
$$;

COMMIT;
