-- Replace client-sequenced lineup swaps with one transactional multi-move RPC.
-- Also installs the canonical SQL slot-eligibility helper for databases that
-- already applied the earlier 20260608 lineup hardening migrations.

CREATE OR REPLACE FUNCTION public.lineup_slot_allowed_positions(
  p_slot_type roster_slot_type
)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_slot_type
    WHEN 'PG'::roster_slot_type THEN ARRAY['PG']::text[]
    WHEN 'SG'::roster_slot_type THEN ARRAY['SG']::text[]
    WHEN 'SF'::roster_slot_type THEN ARRAY['SF']::text[]
    WHEN 'PF'::roster_slot_type THEN ARRAY['PF']::text[]
    WHEN 'C'::roster_slot_type THEN ARRAY['C']::text[]
    WHEN 'G'::roster_slot_type THEN ARRAY['PG', 'SG']::text[]
    WHEN 'F'::roster_slot_type THEN ARRAY['SF', 'PF']::text[]
    WHEN 'UTIL'::roster_slot_type THEN ARRAY['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']::text[]
    WHEN 'BE'::roster_slot_type THEN ARRAY['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']::text[]
    ELSE '{}'::text[]
  END
$$;

CREATE OR REPLACE FUNCTION public.set_player_slot_moves_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_week_number int,
  p_moves jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    JOIN nba_games g
      ON g.game_date = wl.game_date
     AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
   WHERE wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND (
       g.status IN ('InProgress', 'Final')
       OR (g.game_time IS NOT NULL AND g.game_time <= now())
     )
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
    JOIN nba_games g
      ON g.game_date = p_game_date
     AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
    LEFT JOIN weekly_lineups wl
      ON wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND wl.player_id = f.player_id
     AND wl.slot_type = f.slot_type
   WHERE wl.id IS NULL
     AND (
       g.status IN ('InProgress', 'Final')
       OR (g.game_time IS NOT NULL AND g.game_time <= now())
     )
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
$$;

CREATE OR REPLACE FUNCTION public.set_player_slot_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid,
  p_game_date date,
  p_slot_type roster_slot_type,
  p_week_number int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.set_player_slot_moves_atomic(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_week_number,
    jsonb_build_array(jsonb_build_object(
      'player_id', p_player_id,
      'slot_type', p_slot_type
    ))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_set_lineup_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_assignments jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    JOIN nba_games g
      ON g.game_date = wl.game_date
     AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
   WHERE wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND (
       g.status IN ('InProgress', 'Final')
       OR (g.game_time IS NOT NULL AND g.game_time <= now())
     )
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
    JOIN nba_games g
      ON g.game_date = p_game_date
     AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
    LEFT JOIN weekly_lineups wl
      ON wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND wl.player_id = a.player_id
     AND wl.slot_type = a.slot_type
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND wl.id IS NULL
     AND (
       g.status IN ('InProgress', 'Final')
       OR (g.game_time IS NOT NULL AND g.game_time <= now())
     )
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
$$;

REVOKE ALL ON FUNCTION public.lineup_slot_allowed_positions(roster_slot_type) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_player_slot_moves_atomic(uuid, uuid, uuid, date, int, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_player_slot_moves_atomic(uuid, uuid, uuid, date, int, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) FROM anon;
REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.lineup_slot_allowed_positions(roster_slot_type) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_player_slot_moves_atomic(uuid, uuid, uuid, date, int, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) TO authenticated, service_role;
