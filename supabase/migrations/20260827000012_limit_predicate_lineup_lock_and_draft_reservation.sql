-- One owner for the weekly-limit predicate and for the lineup lock; rookie
-- drafts wait for reserved picks.
--
-- private.weekly_add_limit_reached is the predicate the rejection sentence and
-- the member state both compose. private.lineup_game_started is the one
-- "this slot's game has started" rule, read by the lineup RPCs, the roster
-- lifecycle cleanup, and the DB suites. start_rookie_draft_atomic refuses to
-- start while a pick of the draft class is named in an accepted trade, which
-- would otherwise stall that slot until the trade completes.


CREATE OR REPLACE FUNCTION private.weekly_add_limit_reached(p_used int, p_limit int)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_limit IS NOT NULL AND COALESCE(p_used, 0) >= p_limit
$$;

CREATE OR REPLACE FUNCTION private.weekly_add_limit_message(
  p_used int,
  p_limit int,
  p_resets_at timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  -- The rejection sentence while the week's adds are used up, NULL otherwise.
  SELECT CASE
           WHEN private.weekly_add_limit_reached(p_used, p_limit)
           THEN format('Weekly add limit reached (%s/%s adds used this week).', COALESCE(p_used, 0), p_limit)
             || COALESCE(format(' Adds reset %s.', private.weekly_add_limit_reset_label(p_resets_at)), '')
         END;
$$;

CREATE OR REPLACE FUNCTION private.assert_weekly_add_available(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_limit int;
  v_week int;
  v_resets_at timestamptz;
  v_used int;
  v_message text;
BEGIN
  SELECT weekly_add_limit
    INTO v_limit
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF v_limit IS NULL THEN
    RETURN;
  END IF;

  SELECT week.week_number, week.resets_at
    INTO v_week, v_resets_at
    FROM private.current_add_week(p_league_id, p_league_season_id) AS week;

  INSERT INTO weekly_add_counts (
    league_id,
    league_season_id,
    member_id,
    week_number,
    add_count
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_member_id,
    v_week,
    0
  )
  ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO NOTHING;

  SELECT count_row.add_count
    INTO v_used
    FROM weekly_add_counts AS count_row
   WHERE count_row.league_id = p_league_id
     AND count_row.league_season_id = p_league_season_id
     AND count_row.member_id = p_member_id
     AND count_row.week_number = v_week
   FOR UPDATE;

  v_message := private.weekly_add_limit_message(v_used, v_limit, v_resets_at);
  IF v_message IS NOT NULL THEN
    RAISE EXCEPTION '%', v_message USING ERRCODE = 'PA001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_not_reserved_trade_asset(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF private.is_reserved_trade_asset(p_league_id, p_league_season_id, p_member_id, p_player_id, p_pick_id, p_exclude_trade_id) THEN
    RAISE EXCEPTION '%', private.reserved_trade_asset_message() USING ERRCODE = 'PA004';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.lineup_game_started(p_player_id uuid, p_game_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- A lineup slot locks once the player's game that day has started: the feed
  -- says so, its scheduled tip-off has passed, or a start time is recorded.
  SELECT EXISTS (
    SELECT 1
      FROM players AS p
      JOIN nba_games AS g
        ON g.game_date = p_game_date
       AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
     WHERE p.id = p_player_id
       AND (
         g.status IN ('InProgress', 'Final')
         OR (g.game_time IS NOT NULL AND g.game_time <= now())
         OR (g.started_at IS NOT NULL AND g.started_at <= now())
       )
  )
$$;

CREATE OR REPLACE FUNCTION private.clear_future_unlocked_lineups(
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid,
  p_member_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM weekly_lineups AS wl
   WHERE wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.player_id = p_player_id
     AND (p_member_id IS NULL OR wl.member_id = p_member_id)
     AND wl.game_date >= (now() AT TIME ZONE 'America/New_York')::date
     AND NOT private.lineup_game_started(wl.player_id, wl.game_date);
$$;

CREATE OR REPLACE FUNCTION public.auto_set_lineup_atomic_unchecked(p_member_id uuid, p_league_id uuid, p_league_season_id uuid, p_game_date date, p_assignments jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_player_ids uuid[];
  v_owned_count int;
  v_total_count int;
  v_duplicate_player uuid;
  v_invalid_slot roster_slot_type;
  v_invalid_player text;
  v_invalid_player_slot roster_slot_type;
  v_locked_player text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(p_member_id::text),
    hashtext(p_game_date::text)
  );

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Lineups can only be set during an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_assignments) AS a
     WHERE a->>'player_id' IS NULL
        OR a->>'slot_type' IS NULL
  ) THEN
    RAISE EXCEPTION 'Every lineup assignment must include player_id and slot_type.'
      USING ERRCODE = '22023';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT player_id
    INTO v_duplicate_player
    FROM assignments
   GROUP BY player_id
  HAVING count(*) > 1
   LIMIT 1;

  IF v_duplicate_player IS NOT NULL THEN
    RAISE EXCEPTION 'A player can only appear once in a lineup.'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT (a->>'player_id')::uuid ORDER BY (a->>'player_id')::uuid)
    INTO v_player_ids
    FROM jsonb_array_elements(p_assignments) AS a
   WHERE a->>'player_id' IS NOT NULL;

  v_player_ids := COALESCE(v_player_ids, ARRAY[]::uuid[]);

  IF array_length(v_player_ids, 1) IS NOT NULL THEN
    PERFORM 1
       FROM roster_players
      WHERE member_id = p_member_id
        AND league_id = p_league_id
        AND league_season_id = p_league_season_id
        AND player_id = ANY (v_player_ids)
      FOR SHARE;

    SELECT count(*)
      INTO v_owned_count
      FROM roster_players
     WHERE member_id = p_member_id
       AND league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND player_id = ANY (v_player_ids);

    v_total_count := array_length(v_player_ids, 1);
    IF v_owned_count <> v_total_count THEN
      RAISE EXCEPTION 'One or more players in the lineup are no longer on your roster.'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT slot_type
    INTO v_invalid_slot
    FROM assignments
   WHERE slot_type = 'IR'::roster_slot_type
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Use the roster injured reserve action instead of assigning an IR lineup slot.'
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT a.slot_type
    INTO v_invalid_slot
    FROM assignments a
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND NOT EXISTS (
       SELECT 1
         FROM lineup_slot_templates t
        WHERE t.league_id = p_league_id
          AND t.slot_type = a.slot_type
          AND t.slot_type NOT IN ('BE'::roster_slot_type, 'IR'::roster_slot_type)
     )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % is not configured for this league.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT a.slot_type
    INTO v_invalid_slot
    FROM assignments a
   WHERE a.slot_type <> 'BE'::roster_slot_type
   GROUP BY a.slot_type
  HAVING count(*) > (
      SELECT t.slot_count
        FROM lineup_slot_templates t
       WHERE t.league_id = p_league_id
         AND t.slot_type = a.slot_type
   )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % has too many players.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name, a.slot_type
    INTO v_invalid_player, v_invalid_player_slot
    FROM assignments a
    JOIN roster_players rp
      ON rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.player_id = a.player_id
    JOIN players p ON p.id = rp.player_id
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND (rp.is_on_ir OR COALESCE(rp.is_on_taxi, false))
   LIMIT 1;

  IF v_invalid_player IS NOT NULL THEN
    RAISE EXCEPTION 'Activate % before assigning a starter slot.', v_invalid_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  ),
  player_slots AS (
    SELECT
      p.display_name,
      a.slot_type,
      CASE
        WHEN cardinality(COALESCE(p.eligible_positions, '{}'::text[])) > 0
          THEN p.eligible_positions
        WHEN p.position IS NOT NULL
          THEN ARRAY[p.position::text]::text[]
        ELSE '{}'::text[]
      END AS eligible_positions,
      public.lineup_slot_allowed_positions(a.slot_type) AS allowed_positions
      FROM assignments a
      JOIN players p ON p.id = a.player_id
     WHERE a.slot_type <> 'BE'::roster_slot_type
  )
  SELECT display_name, slot_type
    INTO v_invalid_player, v_invalid_player_slot
    FROM player_slots
   WHERE NOT (eligible_positions && allowed_positions)
   LIMIT 1;

  IF v_invalid_player IS NOT NULL THEN
    RAISE EXCEPTION '% is not eligible for %.', v_invalid_player, v_invalid_player_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM weekly_lineups wl
    JOIN players p ON p.id = wl.player_id
   WHERE wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND private.lineup_game_started(wl.player_id, wl.game_date)
     AND NOT EXISTS (
       SELECT 1
         FROM assignments a
        WHERE a.player_id = wl.player_id
          AND a.slot_type = wl.slot_type
     )
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked because %''s game has already started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM assignments a
    JOIN players p ON p.id = a.player_id
    LEFT JOIN weekly_lineups wl
      ON wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND wl.player_id = a.player_id
     AND wl.slot_type = a.slot_type
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND wl.id IS NULL
     AND private.lineup_game_started(a.player_id, p_game_date)
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked after %''s game has started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM weekly_lineups
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND game_date = p_game_date;

  INSERT INTO weekly_lineups (
    member_id,
    league_id,
    league_season_id,
    player_id,
    week_number,
    game_date,
    slot_type,
    is_auto_set,
    set_at
  )
  SELECT
    p_member_id,
    p_league_id,
    p_league_season_id,
    (a->>'player_id')::uuid,
    COALESCE((a->>'week_number')::int, 1),
    p_game_date,
    (a->>'slot_type')::roster_slot_type,
    COALESCE((a->>'is_auto_set')::boolean, true),
    now()
    FROM jsonb_array_elements(p_assignments) AS a
   WHERE a->>'player_id' IS NOT NULL
     AND a->>'slot_type' IS NOT NULL
     AND (a->>'slot_type')::roster_slot_type <> 'BE'::roster_slot_type;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_player_slot_moves_atomic_unchecked(p_member_id uuid, p_league_id uuid, p_league_season_id uuid, p_game_date date, p_week_number integer, p_moves jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_player_ids uuid[];
  v_owned_count int;
  v_total_count int;
  v_duplicate_player uuid;
  v_invalid_slot roster_slot_type;
  v_invalid_player text;
  v_invalid_player_slot roster_slot_type;
  v_invalid_player_inactive boolean := false;
  v_locked_player text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(p_member_id::text),
    hashtext(p_game_date::text)
  );

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Lineups can only be set during an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'p_moves must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_moves) AS m
     WHERE m->>'player_id' IS NULL
        OR m->>'slot_type' IS NULL
  ) THEN
    RAISE EXCEPTION 'Every lineup move must include player_id and slot_type.'
      USING ERRCODE = '22023';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  )
  SELECT player_id
    INTO v_duplicate_player
    FROM moves
   GROUP BY player_id
  HAVING count(*) > 1
   LIMIT 1;

  IF v_duplicate_player IS NOT NULL THEN
    RAISE EXCEPTION 'A player can only appear once in a lineup move.'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT (m->>'player_id')::uuid ORDER BY (m->>'player_id')::uuid)
    INTO v_player_ids
    FROM jsonb_array_elements(p_moves) AS m
   WHERE m->>'player_id' IS NOT NULL;

  v_player_ids := COALESCE(v_player_ids, ARRAY[]::uuid[]);

  IF array_length(v_player_ids, 1) IS NOT NULL THEN
    PERFORM 1
       FROM roster_players
      WHERE member_id = p_member_id
        AND league_id = p_league_id
        AND league_season_id = p_league_season_id
        AND player_id = ANY (v_player_ids)
      FOR SHARE;

    SELECT count(*)
      INTO v_owned_count
      FROM roster_players
     WHERE member_id = p_member_id
       AND league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND player_id = ANY (v_player_ids);

    v_total_count := array_length(v_player_ids, 1);
    IF v_owned_count <> v_total_count THEN
      RAISE EXCEPTION 'One or more players in the lineup are no longer on your roster.'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  )
  SELECT slot_type
    INTO v_invalid_slot
    FROM moves
   WHERE slot_type = 'IR'::roster_slot_type
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Use the roster injured reserve action instead of assigning an IR lineup slot.'
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  ),
  final_lineups AS (
    SELECT wl.player_id, wl.slot_type
      FROM weekly_lineups wl
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND NOT EXISTS (SELECT 1 FROM moves m WHERE m.player_id = wl.player_id)
    UNION ALL
    SELECT player_id, slot_type
      FROM moves
     WHERE slot_type <> 'BE'::roster_slot_type
  )
  SELECT f.slot_type
    INTO v_invalid_slot
    FROM final_lineups f
   WHERE NOT EXISTS (
     SELECT 1
       FROM lineup_slot_templates t
      WHERE t.league_id = p_league_id
        AND t.slot_type = f.slot_type
        AND t.slot_type NOT IN ('BE'::roster_slot_type, 'IR'::roster_slot_type)
   )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % is not configured for this league.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  ),
  final_lineups AS (
    SELECT wl.player_id, wl.slot_type
      FROM weekly_lineups wl
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND NOT EXISTS (SELECT 1 FROM moves m WHERE m.player_id = wl.player_id)
    UNION ALL
    SELECT player_id, slot_type
      FROM moves
     WHERE slot_type <> 'BE'::roster_slot_type
  )
  SELECT f.slot_type
    INTO v_invalid_slot
    FROM final_lineups f
   GROUP BY f.slot_type
  HAVING count(*) > (
      SELECT t.slot_count
        FROM lineup_slot_templates t
       WHERE t.league_id = p_league_id
         AND t.slot_type = f.slot_type
   )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % is full.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  ),
  final_lineups AS (
    SELECT wl.player_id, wl.slot_type
      FROM weekly_lineups wl
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND NOT EXISTS (SELECT 1 FROM moves m WHERE m.player_id = wl.player_id)
    UNION ALL
    SELECT player_id, slot_type
      FROM moves
     WHERE slot_type <> 'BE'::roster_slot_type
  ),
  player_slots AS (
    SELECT
      p.display_name,
      f.slot_type,
      rp.is_on_ir,
      COALESCE(rp.is_on_taxi, false) AS is_on_taxi,
      CASE
        WHEN cardinality(COALESCE(p.eligible_positions, '{}'::text[])) > 0
          THEN p.eligible_positions
        WHEN p.position IS NOT NULL
          THEN ARRAY[p.position::text]::text[]
        ELSE '{}'::text[]
      END AS eligible_positions,
      public.lineup_slot_allowed_positions(f.slot_type) AS allowed_positions
      FROM final_lineups f
      JOIN roster_players rp
        ON rp.member_id = p_member_id
       AND rp.league_id = p_league_id
       AND rp.league_season_id = p_league_season_id
       AND rp.player_id = f.player_id
      JOIN players p ON p.id = f.player_id
  )
  SELECT display_name, slot_type, is_on_ir OR is_on_taxi
    INTO v_invalid_player, v_invalid_player_slot, v_invalid_player_inactive
    FROM player_slots
   WHERE is_on_ir OR is_on_taxi OR NOT (eligible_positions && allowed_positions)
   LIMIT 1;

  IF v_invalid_player IS NOT NULL THEN
    IF v_invalid_player_inactive THEN
      RAISE EXCEPTION 'Activate % before assigning a starter slot.', v_invalid_player
        USING ERRCODE = 'P0001';
    END IF;

    RAISE EXCEPTION '% is not eligible for %.', v_invalid_player, v_invalid_player_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  ),
  final_lineups AS (
    SELECT wl.player_id, wl.slot_type
      FROM weekly_lineups wl
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND NOT EXISTS (SELECT 1 FROM moves m WHERE m.player_id = wl.player_id)
    UNION ALL
    SELECT player_id, slot_type
      FROM moves
     WHERE slot_type <> 'BE'::roster_slot_type
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM weekly_lineups wl
    JOIN players p ON p.id = wl.player_id
   WHERE wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND private.lineup_game_started(wl.player_id, wl.game_date)
     AND NOT EXISTS (
       SELECT 1
         FROM final_lineups f
        WHERE f.player_id = wl.player_id
          AND f.slot_type = wl.slot_type
     )
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked because %''s game has already started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  ),
  final_lineups AS (
    SELECT wl.player_id, wl.slot_type
      FROM weekly_lineups wl
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND NOT EXISTS (SELECT 1 FROM moves m WHERE m.player_id = wl.player_id)
    UNION ALL
    SELECT player_id, slot_type
      FROM moves
     WHERE slot_type <> 'BE'::roster_slot_type
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM final_lineups f
    JOIN players p ON p.id = f.player_id
    LEFT JOIN weekly_lineups wl
      ON wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND wl.player_id = f.player_id
     AND wl.slot_type = f.slot_type
   WHERE wl.id IS NULL
     AND private.lineup_game_started(f.player_id, p_game_date)
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked after %''s game has started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  )
  DELETE FROM weekly_lineups wl
   USING moves m
   WHERE wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND wl.player_id = m.player_id
     AND (m.slot_type = 'BE'::roster_slot_type OR wl.slot_type <> m.slot_type);

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  )
  INSERT INTO weekly_lineups (
    member_id,
    league_id,
    league_season_id,
    player_id,
    week_number,
    game_date,
    slot_type,
    is_auto_set,
    set_at
  )
  SELECT
    p_member_id,
    p_league_id,
    p_league_season_id,
    m.player_id,
    p_week_number,
    p_game_date,
    m.slot_type,
    false,
    now()
    FROM moves m
   WHERE m.slot_type <> 'BE'::roster_slot_type
     AND NOT EXISTS (
       SELECT 1
         FROM weekly_lineups wl
        WHERE wl.member_id = p_member_id
          AND wl.league_id = p_league_id
          AND wl.league_season_id = p_league_season_id
          AND wl.game_date = p_game_date
          AND wl.player_id = m.player_id
          AND wl.slot_type = m.slot_type
     )
  ON CONFLICT (league_id, league_season_id, member_id, player_id, game_date)
  DO UPDATE SET
    slot_type = EXCLUDED.slot_type,
    week_number = EXCLUDED.week_number,
    is_auto_set = EXCLUDED.is_auto_set,
    set_at = EXCLUDED.set_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_rookie_draft_atomic(
  p_league_id uuid,
  p_rounds int DEFAULT 3,
  p_is_mock boolean DEFAULT false,
  p_pick_timer_seconds int DEFAULT 30,
  p_timer_expiry_behavior text DEFAULT 'auto_pick'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season league_seasons%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_member_count int;
  v_order_count int;
  v_last_season_id uuid;
  v_pick_count int;
  v_is_mock boolean := COALESCE(p_is_mock, false);
  v_timer_expiry_behavior text := COALESCE(p_timer_expiry_behavior, 'auto_pick');
BEGIN
  IF p_rounds < 1 OR p_rounds > 3 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 3.';
  END IF;
  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 5 OR p_pick_timer_seconds > 3600 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 5 and 3600.'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_timer_expiry_behavior NOT IN ('auto_pick', 'skip_pick', 'pause_draft', 'commissioner_pick') THEN
    RAISE EXCEPTION 'Invalid rookie draft timeout behavior: %', v_timer_expiry_behavior
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF NOT v_is_mock AND v_league.status <> 'offseason' THEN
    RAISE EXCEPTION 'League must be in offseason to start rookie draft';
  END IF;

  SELECT * INTO v_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season for this league';
  END IF;

  IF NOT v_is_mock THEN
    PERFORM 1
      FROM drafts
     WHERE league_id = p_league_id
       AND league_season_id = v_season.id
       AND draft_type = 'snake'
       AND is_mock = false
       AND status IN ('pending', 'in_progress', 'paused')
     FOR UPDATE;

    IF FOUND THEN
      RAISE EXCEPTION 'A rookie draft already exists for this season';
    END IF;
  END IF;

  IF NOT v_is_mock AND EXISTS (
    SELECT 1
      FROM draft_picks AS pick
     WHERE pick.league_id = p_league_id
       AND pick.season_year = v_season.season_year
       AND pick.is_used = false
       AND private.is_reserved_trade_asset(pick.league_id, NULL, pick.current_owner_id, NULL, pick.id)
  ) THEN
    RAISE EXCEPTION 'A pick in this draft class is reserved by an accepted trade. Complete or expire that trade before starting the rookie draft.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
    INTO v_member_count
    FROM league_members
   WHERE league_id = p_league_id;

  IF v_member_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;

  SELECT id
    INTO v_last_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = false
   ORDER BY season_year DESC
   LIMIT 1;

  INSERT INTO drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    started_at,
    is_mock,
    pick_timer_seconds,
    rounds,
    timer_expiry_behavior
  )
  VALUES (
    p_league_id,
    v_season.id,
    'snake',
    'in_progress',
    now(),
    v_is_mock,
    p_pick_timer_seconds,
    p_rounds,
    v_timer_expiry_behavior
  )
  RETURNING * INTO v_draft;

  WITH ordered_members AS (
    SELECT
      lm.id AS member_id,
      CASE WHEN latest.member_id IS NULL THEN 0 ELSE 1 END AS has_standings,
      COALESCE(latest.wins, 0) AS wins,
      COALESCE(latest.points_for, 0) AS points_for
    FROM league_members AS lm
    LEFT JOIN LATERAL (
      SELECT s.member_id, s.wins, s.points_for
        FROM standings AS s
       WHERE v_last_season_id IS NOT NULL
         AND s.league_id = p_league_id
         AND s.league_season_id = v_last_season_id
         AND s.member_id = lm.id
       ORDER BY s.week_number DESC
       LIMIT 1
    ) AS latest ON true
    WHERE lm.league_id = p_league_id
  ),
  rookie_draft_order AS (
    SELECT
      member_id,
      row_number() OVER (
        ORDER BY
          has_standings DESC,
          wins ASC,
          points_for ASC,
          member_id ASC
      )::int AS position
    FROM ordered_members
  )
  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, member_id, position
    FROM rookie_draft_order
   ORDER BY position;

  GET DIAGNOSTICS v_order_count = ROW_COUNT;
  IF v_order_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;
  IF v_order_count <> v_member_count THEN
    RAISE EXCEPTION 'Failed to build a complete rookie draft order';
  END IF;

  IF v_is_mock THEN
    WITH pick_slots AS (
      SELECT
        rounds.round,
        ordered.member_id,
        CASE
          WHEN rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
          ELSE ordered.position
        END AS pick_in_round
      FROM generate_series(1, p_rounds) AS rounds(round)
      CROSS JOIN draft_orders AS ordered
     WHERE ordered.draft_id = v_draft.id
    )
    INSERT INTO snake_draft_picks (
      draft_id,
      overall_pick,
      round,
      pick_in_round,
      member_id,
      draft_pick_id
    )
    SELECT
      v_draft.id,
      ((round - 1) * v_order_count) + pick_in_round,
      round,
      pick_in_round,
      member_id,
      NULL
    FROM pick_slots
    ORDER BY round, pick_in_round;
  ELSE
    WITH pick_slots AS (
      SELECT
        rounds.round,
        ordered.member_id AS original_owner_id,
        CASE
          WHEN rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
          ELSE ordered.position
        END AS pick_in_round
      FROM generate_series(1, p_rounds) AS rounds(round)
      CROSS JOIN draft_orders AS ordered
     WHERE ordered.draft_id = v_draft.id
    ),
    resolved AS (
      SELECT
        pick_slots.round,
        pick_slots.pick_in_round,
        pick_slots.original_owner_id,
        dp.id AS draft_pick_id,
        dp.current_owner_id AS member_id
      FROM pick_slots
      JOIN LATERAL (
        SELECT id, current_owner_id
          FROM draft_picks
         WHERE league_id = p_league_id
           AND season_year = v_season.season_year
           AND round = pick_slots.round
           AND original_owner_id = pick_slots.original_owner_id
           AND is_used = false
         ORDER BY id
         LIMIT 1
         FOR UPDATE
      ) AS dp ON true
    )
    INSERT INTO snake_draft_picks (
      draft_id,
      overall_pick,
      round,
      pick_in_round,
      member_id,
      draft_pick_id
    )
    SELECT
      v_draft.id,
      ((round - 1) * v_order_count) + pick_in_round,
      round,
      pick_in_round,
      member_id,
      draft_pick_id
    FROM resolved
    ORDER BY round, pick_in_round;
  END IF;

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> v_order_count * p_rounds THEN
    RAISE EXCEPTION 'Failed to create every rookie draft pick slot';
  END IF;

  PERFORM private.arm_next_snake_pick_timer(
    v_draft.id,
    now() + make_interval(secs => p_pick_timer_seconds)
  );

  IF NOT v_is_mock THEN
    UPDATE leagues
       SET status = 'drafting'
     WHERE id = p_league_id
       AND status = 'offseason';

    GET DIAGNOSTICS v_pick_count = ROW_COUNT;
    IF v_pick_count <> 1 THEN
      RAISE EXCEPTION 'Failed to mark league as drafting';
    END IF;
  END IF;

  RETURN to_jsonb(v_draft);
END;
$$;
