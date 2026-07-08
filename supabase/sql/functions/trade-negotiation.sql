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
  v_champion_finalized boolean := false;
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

  INSERT INTO trade_items (trade_id, side, player_id, pick_id, from_member_id, to_member_id)
  SELECT v_trade_id, 'proposer'::trade_side, player_id, NULL::uuid, p_proposer_member_id, p_recipient_member_id
    FROM unnest(v_offer_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, player_id, NULL::uuid, p_recipient_member_id, p_proposer_member_id
    FROM unnest(v_request_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'proposer'::trade_side, NULL::uuid, pick_id, p_proposer_member_id, p_recipient_member_id
    FROM unnest(v_offer_pick_ids) AS pick_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, NULL::uuid, pick_id, p_recipient_member_id, p_proposer_member_id
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

CREATE OR REPLACE FUNCTION private.create_multi_team_trade_offer(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
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

  DROP TABLE IF EXISTS pg_temp.multi_trade_participants_stage;
  CREATE TEMP TABLE multi_trade_participants_stage (
    sort_order int NOT NULL,
    member_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO multi_trade_participants_stage (sort_order, member_id)
  VALUES (0, p_proposer_member_id);

  INSERT INTO multi_trade_participants_stage (sort_order, member_id)
  SELECT ordinality::int, member_id
    FROM unnest(COALESCE(p_participant_member_ids, ARRAY[]::uuid[])) WITH ORDINALITY AS participant(member_id, ordinality)
   WHERE member_id <> p_proposer_member_id
  ON CONFLICT (member_id) DO NOTHING;

  SELECT count(*) INTO v_participant_count FROM multi_trade_participants_stage;
  IF v_participant_count < 2 THEN
    RAISE EXCEPTION 'A multi-team trade requires at least two participating teams.'
      USING ERRCODE = '22023';
  END IF;

  DROP TABLE IF EXISTS pg_temp.multi_trade_items_stage;
  CREATE TEMP TABLE multi_trade_items_stage (
    sort_order int NOT NULL,
    from_member_id uuid NOT NULL,
    to_member_id uuid NOT NULL,
    player_id uuid,
    pick_id uuid,
    faab_amount int NOT NULL DEFAULT 0
  ) ON COMMIT DROP;

  INSERT INTO multi_trade_items_stage (
    sort_order,
    from_member_id,
    to_member_id,
    player_id,
    pick_id,
    faab_amount
  )
  SELECT
    ordinality::int,
    NULLIF(item->>'fromMemberId', '')::uuid,
    NULLIF(item->>'toMemberId', '')::uuid,
    NULLIF(item->>'playerId', '')::uuid,
    NULLIF(item->>'pickId', '')::uuid,
    COALESCE(NULLIF(item->>'faabAmount', '')::int, 0)
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS entry(item, ordinality);

  IF NOT EXISTS (SELECT 1 FROM multi_trade_items_stage) THEN
    RAISE EXCEPTION 'A trade must include at least one asset.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM multi_trade_items_stage
     WHERE from_member_id = to_member_id
        OR faab_amount < 0
        OR ((player_id IS NOT NULL)::int + (pick_id IS NOT NULL)::int + (faab_amount > 0)::int) <> 1
  ) THEN
    RAISE EXCEPTION 'Each multi-team trade item must route exactly one player, pick, or positive FAAB amount between two different teams.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM multi_trade_items_stage AS item
     WHERE NOT EXISTS (
       SELECT 1 FROM multi_trade_participants_stage AS participant WHERE participant.member_id = item.from_member_id
     )
        OR NOT EXISTS (
       SELECT 1 FROM multi_trade_participants_stage AS participant WHERE participant.member_id = item.to_member_id
     )
  ) THEN
    RAISE EXCEPTION 'Every item source and destination must be a trade participant.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM multi_trade_participants_stage AS participant
     WHERE NOT EXISTS (
       SELECT 1
         FROM multi_trade_items_stage AS item
        WHERE item.from_member_id = participant.member_id
           OR item.to_member_id = participant.member_id
     )
  ) THEN
    RAISE EXCEPTION 'Every participating team must send or receive at least one asset.'
      USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(player_id) FROM multi_trade_items_stage WHERE player_id IS NOT NULL) <>
     (SELECT count(DISTINCT player_id) FROM multi_trade_items_stage WHERE player_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Duplicate traded players are not allowed.';
  END IF;

  IF (SELECT count(pick_id) FROM multi_trade_items_stage WHERE pick_id IS NOT NULL) <>
     (SELECT count(DISTINCT pick_id) FROM multi_trade_items_stage WHERE pick_id IS NOT NULL) THEN
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

  IF EXISTS (SELECT 1 FROM multi_trade_items_stage WHERE faab_amount > 0)
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
    JOIN multi_trade_participants_stage AS participant
      ON participant.member_id = member.id
   WHERE member.league_id = p_league_id;

  IF v_rows <> v_participant_count THEN
    RAISE EXCEPTION 'Every trade participant must be a member of this league.';
  END IF;

  WITH locked AS (
    SELECT item.player_id
      FROM multi_trade_items_stage AS item
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
  IF v_rows <> (SELECT count(*) FROM multi_trade_items_stage WHERE player_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A player asset is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT item.pick_id
      FROM multi_trade_items_stage AS item
      JOIN draft_picks AS pick
        ON pick.id = item.pick_id
       AND pick.league_id = p_league_id
       AND pick.current_owner_id = item.from_member_id
       AND pick.is_used = false
     WHERE item.pick_id IS NOT NULL
     FOR SHARE OF pick
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> (SELECT count(*) FROM multi_trade_items_stage WHERE pick_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A draft pick asset is no longer owned by the expected team.';
  END IF;

  FOR v_faab IN
    SELECT from_member_id, sum(faab_amount)::int AS amount
      FROM multi_trade_items_stage
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
    FROM multi_trade_participants_stage
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
    is_multi_team
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    v_first_recipient_member_id,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending',
    p_expires_at,
    true
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
  FROM multi_trade_participants_stage
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
  FROM multi_trade_items_stage
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
      'item_count', (SELECT count(*) FROM multi_trade_items_stage)
    )
  );

  RETURN v_trade_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.propose_multi_team_trade_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.create_multi_team_trade_offer(
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_participant_member_ids,
    p_items,
    p_notes,
    p_expires_at
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
  v_item_faab_amount int;
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
        UNION
        SELECT participant.member_id
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
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

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.'
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
    v_from_member := COALESCE(v_item.from_member_id, CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END);

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
    ELSIF v_item.pick_id IS NOT NULL THEN
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
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

      v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member);
      IF v_balance < v_item_faab_amount THEN
        RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
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
    v_from_member := COALESCE(v_item.from_member_id, CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END);
    v_to_member := COALESCE(v_item.to_member_id, CASE
      WHEN v_item.side = 'proposer' THEN v_trade.recipient_member_id
      ELSE v_trade.proposer_member_id
    END);

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
    ELSIF v_item.pick_id IS NOT NULL THEN
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
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

      UPDATE faab_balances
         SET balance = balance - v_item_faab_amount,
             updated_at = now()
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member;

      INSERT INTO faab_balances (
        league_id,
        league_season_id,
        member_id,
        balance
      )
      VALUES (
        v_trade.league_id,
        v_trade.league_season_id,
        v_to_member,
        v_item_faab_amount
      )
      ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
         SET balance = faab_balances.balance + EXCLUDED.balance,
             updated_at = now();
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
    UNION
    SELECT participant.member_id
      FROM trade_participants AS participant
     WHERE participant.trade_id = p_trade_id
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
      'recipient_faab_amount', v_trade.recipient_faab_amount,
      'is_multi_team', COALESCE(v_trade.is_multi_team, false)
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_multi_team_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid,
  p_drop_roster_player_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_drop_ids uuid[] := COALESCE(p_drop_roster_player_ids, ARRAY[]::uuid[]);
  v_from_member uuid;
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_active_count int;
  v_incoming_players int;
  v_outgoing_players int;
  v_required_drops int;
  v_all_accepted boolean;
  v_veto_window_hours int;
  v_item_faab_amount int;
  v_balance int;
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

  IF COALESCE(v_trade.is_multi_team, false) = false THEN
    RAISE EXCEPTION 'This trade is not a multi-team offer.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;
    RAISE EXCEPTION 'This trade offer has expired.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM trade_participants
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a trade participant can accept this trade.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND member_id = p_accepting_member_id
       AND accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'This participant has already accepted the trade.'
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_member_lock IN
    SELECT participant.member_id
      FROM trade_participants AS participant
     WHERE participant.trade_id = p_trade_id
     ORDER BY participant.member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_member_lock::text)
    );
  END LOOP;

  IF (SELECT count(*) FROM unnest(v_drop_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_drop_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate drop players are not allowed.';
  END IF;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM (
        SELECT player_id
          FROM trade_items
         WHERE trade_id = p_trade_id
           AND player_id IS NOT NULL
        UNION ALL
        SELECT player_id
          FROM roster_players
         WHERE id = ANY(v_drop_ids)
      ) AS touched
     WHERE player_id IS NOT NULL
     ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.'
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
    v_from_member := COALESCE(v_item.from_member_id, CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END);

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
        RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM trade_items AS accepted_item
          JOIN trades AS accepted_trade
            ON accepted_trade.id = accepted_item.trade_id
           AND accepted_trade.status = 'accepted'::trade_status
         WHERE accepted_item.player_id = v_item.player_id
           AND accepted_trade.id <> p_trade_id
           AND accepted_trade.league_id = v_trade.league_id
           AND accepted_trade.league_season_id = v_trade.league_season_id
           AND COALESCE(
             accepted_item.from_member_id,
             CASE WHEN accepted_item.side = 'proposer' THEN accepted_trade.proposer_member_id ELSE accepted_trade.recipient_member_id END
           ) = v_from_member
      ) THEN
        RAISE EXCEPTION 'Player asset is reserved for another accepted trade';
      END IF;
    ELSIF v_item.pick_id IS NOT NULL THEN
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM trade_items AS accepted_item
          JOIN trades AS accepted_trade
            ON accepted_trade.id = accepted_item.trade_id
           AND accepted_trade.status = 'accepted'::trade_status
         WHERE accepted_item.pick_id = v_item.pick_id
           AND accepted_trade.id <> p_trade_id
           AND accepted_trade.league_id = v_trade.league_id
           AND accepted_trade.league_season_id = v_trade.league_season_id
      ) THEN
        RAISE EXCEPTION 'Draft-pick asset is reserved for another accepted trade';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount';
      END IF;

      v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member);
      IF v_balance < v_item_faab_amount THEN
        RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.';
      END IF;
    END IF;
  END LOOP;

  IF cardinality(v_drop_ids) > 0 THEN
    WITH locked AS (
      SELECT *
        FROM roster_players
       WHERE id = ANY(v_drop_ids)
         AND league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = p_accepting_member_id
         AND is_on_ir = false
         AND is_on_taxi = false
       FOR UPDATE
    )
    SELECT count(*) INTO v_rows FROM locked;

    IF v_rows <> cardinality(v_drop_ids) THEN
      RAISE EXCEPTION 'Drop list includes a player that is no longer on your active roster.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM roster_players AS rp
        JOIN trade_items AS ti
          ON ti.trade_id = p_trade_id
         AND ti.player_id = rp.player_id
       WHERE rp.id = ANY(v_drop_ids)
    ) THEN
      RAISE EXCEPTION 'You cannot drop a player included in this trade.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM trade_drop_reservations AS reservation
        JOIN trades AS trade
          ON trade.id = reservation.trade_id
         AND trade.status = 'accepted'::trade_status
       WHERE reservation.roster_player_id = ANY(v_drop_ids)
         AND reservation.trade_id <> p_trade_id
    ) THEN
      RAISE EXCEPTION 'A selected drop player is already reserved for another accepted trade.';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE league_id = v_trade.league_id
     AND league_season_id = v_trade.league_season_id
     AND member_id = p_accepting_member_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  SELECT count(*)
    INTO v_incoming_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND COALESCE(to_member_id, CASE WHEN side = 'proposer' THEN v_trade.recipient_member_id ELSE v_trade.proposer_member_id END) = p_accepting_member_id
     AND player_id IS NOT NULL;

  SELECT count(*)
    INTO v_outgoing_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND COALESCE(from_member_id, CASE WHEN side = 'proposer' THEN v_trade.proposer_member_id ELSE v_trade.recipient_member_id END) = p_accepting_member_id
     AND player_id IS NOT NULL;

  v_required_drops := GREATEST(v_active_count - v_outgoing_players + v_incoming_players - COALESCE(v_league.roster_size, 0), 0);
  IF cardinality(v_drop_ids) <> v_required_drops THEN
    RAISE EXCEPTION 'Accepting this trade requires exactly % active roster drop(s).', v_required_drops;
  END IF;

  DELETE FROM trade_drop_reservations
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id;

  INSERT INTO trade_drop_reservations (
    trade_id,
    roster_player_id,
    member_id,
    player_id
  )
  SELECT
    p_trade_id,
    rp.id,
    rp.member_id,
    rp.player_id
  FROM roster_players AS rp
  WHERE rp.id = ANY(v_drop_ids)
  ORDER BY rp.player_id ASC;

  UPDATE trade_participants
     SET accepted_at = now()
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id
     AND accepted_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record participant acceptance.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT NOT EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND accepted_at IS NULL
  )
    INTO v_all_accepted;

  IF v_all_accepted THEN
    v_veto_window_hours := CASE
      WHEN COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled' THEN 0
      ELSE LEAST(GREATEST(COALESCE(v_league.trade_veto_window_hours, 24), 0), 168)
    END;

    UPDATE trades
       SET status = 'accepted',
           accepted_at = now(),
           veto_window_expires_at = now() + make_interval(hours => v_veto_window_hours),
           completed_at = NULL,
           vetoed_at = NULL
     WHERE id = p_trade_id
       AND status = 'pending';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Failed to accept trade atomically';
    END IF;

    IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled'
       OR v_veto_window_hours = 0 THEN
      PERFORM public.complete_accepted_trade_atomic(p_trade_id);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'allAccepted', v_all_accepted,
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id,
    'participantMemberIds', (
      SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
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

  IF COALESCE(v_trade.is_multi_team, false) THEN
    IF v_trade.proposer_member_id = p_member_id OR NOT EXISTS (
      SELECT 1
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
         AND participant.member_id = p_member_id
         AND participant.accepted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Only a non-proposer trade participant can reject this trade.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_trade.recipient_member_id <> p_member_id THEN
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
      AND league.status <> 'archived'::public.league_status
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
