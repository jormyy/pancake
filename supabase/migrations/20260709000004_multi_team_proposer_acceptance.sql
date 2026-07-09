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
    NULL::timestamptz
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
