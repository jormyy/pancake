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
  v_slot record;
  v_candidate uuid;
  v_preserve boolean;
  v_projections jsonb;
  v_week_number int;
  v_paths jsonb;
  v_path jsonb;
  v_seen text[];
  v_next record;
  v_repair_players uuid[];
  v_repair_slots text[];
  v_index int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
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
   FOR NO KEY UPDATE;

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
      FROM unnest(v_player_ids) AS requested(player_id)
     WHERE EXISTS (
       SELECT 1 FROM roster_players rp
        WHERE rp.member_id = p_member_id
          AND rp.league_id = p_league_id
          AND rp.league_season_id = p_league_season_id
          AND rp.player_id = requested.player_id
     ) OR EXISTS (
       SELECT 1
         FROM weekly_lineups wl
         JOIN jsonb_array_elements(p_assignments) AS a
           ON (a->>'player_id')::uuid = wl.player_id
          AND (a->>'slot_type')::roster_slot_type = wl.slot_type
        WHERE wl.member_id = p_member_id
          AND wl.league_id = p_league_id
          AND wl.league_season_id = p_league_season_id
          AND wl.game_date = p_game_date
          AND wl.player_id = requested.player_id
          AND private.lineup_game_started(wl.player_id, wl.game_date)
     );

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

  SELECT COALESCE(jsonb_agg(a), '[]'::jsonb)
    INTO p_assignments
    FROM jsonb_array_elements(p_assignments) a
   WHERE a->>'slot_type' <> 'BE';

  IF EXISTS (
    SELECT 1 FROM lineup_slot_templates t
     WHERE t.league_id = p_league_id AND t.slot_type NOT IN ('BE', 'IR')
       AND t.slot_count > (SELECT count(*) FROM jsonb_array_elements(p_assignments) a
         WHERE a->>'slot_type' = t.slot_type::text)
  ) THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('player_id', projection.player_id,
      'projected', projection.projection_fantasy_points)), '[]'::jsonb)
      INTO v_projections
      FROM public.get_league_projection_rows(
        p_league_id, (SELECT season_year FROM league_seasons WHERE id = p_league_season_id),
        p_game_date, 'today', (SELECT array_agg(player_id) FROM roster_players
          WHERE member_id = p_member_id AND league_id = p_league_id
            AND league_season_id = p_league_season_id AND NOT is_on_ir AND NOT is_on_taxi),
        1000, 0
      ) projection;
    SELECT COALESCE((SELECT week_number FROM season_weeks
      WHERE season_year = (SELECT season_year FROM league_seasons WHERE id = p_league_season_id)
        AND p_game_date BETWEEN week_start AND week_end), 1) INTO v_week_number;

    FOREACH v_preserve IN ARRAY ARRAY[true, false] LOOP
      FOR v_slot IN
        SELECT t.slot_type, sequence.number
          FROM lineup_slot_templates t
          CROSS JOIN LATERAL generate_series(1, t.slot_count) sequence(number)
         WHERE t.league_id = p_league_id AND t.slot_type NOT IN ('BE', 'IR')
         ORDER BY array_position(ARRAY['PG','SG','SF','PF','C','G','F','UTIL'], t.slot_type::text), sequence.number
      LOOP
        IF (SELECT count(*) FROM jsonb_array_elements(p_assignments) a
          WHERE a->>'slot_type' = v_slot.slot_type::text) >= v_slot.number THEN
          CONTINUE;
        END IF;
        WITH stored AS MATERIALIZED (
          SELECT id, player_id FROM weekly_lineups
           WHERE member_id = p_member_id AND league_id = p_league_id
             AND league_season_id = p_league_season_id AND game_date = p_game_date
             AND slot_type = v_slot.slot_type
        )
        SELECT rp.player_id INTO v_candidate
          FROM roster_players rp JOIN players p ON p.id = rp.player_id
          LEFT JOIN stored wl ON wl.player_id = rp.player_id
          LEFT JOIN jsonb_to_recordset(v_projections) projection(player_id uuid, projected numeric)
            ON projection.player_id = rp.player_id
         WHERE rp.member_id = p_member_id AND rp.league_id = p_league_id
           AND rp.league_season_id = p_league_season_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
           AND (NOT v_preserve OR wl.id IS NOT NULL)
           AND NOT private.lineup_game_started(rp.player_id, p_game_date)
           AND COALESCE(NULLIF(p.eligible_positions, '{}'::text[]), ARRAY[p.position::text])
             && public.lineup_slot_allowed_positions(v_slot.slot_type)
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_assignments) a
             WHERE (a->>'player_id')::uuid = rp.player_id)
         ORDER BY (wl.id IS NOT NULL) DESC,
           EXISTS (SELECT 1 FROM nba_games g WHERE g.game_date = p_game_date
             AND private.lineup_game_available(g.status, g.game_status_text)
             AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)) DESC,
           COALESCE(projection.projected, 0) DESC, rp.player_id
         LIMIT 1;
        IF v_candidate IS NULL AND NOT v_preserve THEN
          v_seen := ARRAY[v_slot.slot_type::text];
          v_paths := jsonb_build_array(jsonb_build_object('slots', v_seen, 'players', '[]'::jsonb));
          WHILE jsonb_array_length(v_paths) > 0 LOOP
            v_path := v_paths->0;
            v_paths := v_paths - 0;
            SELECT rp.player_id INTO v_candidate
              FROM roster_players rp JOIN players p ON p.id = rp.player_id
              LEFT JOIN jsonb_to_recordset(v_projections) projection(player_id uuid, projected numeric)
                ON projection.player_id = rp.player_id
             WHERE rp.member_id = p_member_id AND rp.league_id = p_league_id
               AND rp.league_season_id = p_league_season_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
               AND NOT private.lineup_game_started(rp.player_id, p_game_date)
               AND COALESCE(NULLIF(p.eligible_positions, '{}'::text[]), ARRAY[p.position::text])
                 && public.lineup_slot_allowed_positions((v_path->'slots'->>-1)::roster_slot_type)
               AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_assignments) a
                 WHERE (a->>'player_id')::uuid = rp.player_id)
             ORDER BY EXISTS (SELECT 1 FROM nba_games g WHERE g.game_date = p_game_date
               AND private.lineup_game_available(g.status, g.game_status_text)
               AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)) DESC,
               COALESCE(projection.projected, 0) DESC, rp.player_id
             LIMIT 1;
            IF v_candidate IS NOT NULL THEN
              SELECT ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(v_path->'players')) || v_candidate,
                ARRAY(SELECT value FROM jsonb_array_elements_text(v_path->'slots'))
                INTO v_repair_players, v_repair_slots;
              FOR v_index IN 1..cardinality(v_repair_players) LOOP
                SELECT COALESCE(jsonb_agg(a), '[]'::jsonb) INTO p_assignments
                  FROM jsonb_array_elements(p_assignments) a
                 WHERE (a->>'player_id')::uuid <> v_repair_players[v_index];
                p_assignments := p_assignments || jsonb_build_array(jsonb_build_object(
                  'player_id', v_repair_players[v_index], 'slot_type', v_repair_slots[v_index],
                  'week_number', v_week_number, 'is_auto_set', true));
              END LOOP;
              v_candidate := NULL;
              EXIT;
            END IF;
            FOR v_next IN
              SELECT (a->>'player_id')::uuid AS player_id, a->>'slot_type' AS slot_type
                FROM jsonb_array_elements(p_assignments) a
                JOIN roster_players rp ON rp.player_id = (a->>'player_id')::uuid
                  AND rp.member_id = p_member_id AND rp.league_id = p_league_id
                  AND rp.league_season_id = p_league_season_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
                JOIN players p ON p.id = rp.player_id
               WHERE NOT (a->>'slot_type' = ANY(v_seen))
                 AND NOT private.lineup_game_started(p.id, p_game_date)
                 AND COALESCE(NULLIF(p.eligible_positions, '{}'::text[]), ARRAY[p.position::text])
                   && public.lineup_slot_allowed_positions((v_path->'slots'->>-1)::roster_slot_type)
               ORDER BY a->>'slot_type', a->>'player_id'
            LOOP
              IF v_next.slot_type = ANY(v_seen) THEN CONTINUE; END IF;
              v_seen := array_append(v_seen, v_next.slot_type);
              v_paths := v_paths || jsonb_build_array(jsonb_build_object(
                'slots', (v_path->'slots') || to_jsonb(v_next.slot_type),
                'players', (v_path->'players') || to_jsonb(v_next.player_id)));
            END LOOP;
          END LOOP;
        END IF;
        IF v_candidate IS NOT NULL THEN
          p_assignments := p_assignments || jsonb_build_array(jsonb_build_object(
            'player_id', v_candidate, 'slot_type', v_slot.slot_type,
            'week_number', v_week_number, 'is_auto_set', true));
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  DELETE FROM weekly_lineups
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND game_date = p_game_date
     AND NOT private.lineup_game_started(player_id, game_date);

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
     AND (a->>'slot_type')::roster_slot_type <> 'BE'::roster_slot_type
     AND NOT EXISTS (
       SELECT 1 FROM weekly_lineups wl
        WHERE wl.member_id = p_member_id
          AND wl.league_id = p_league_id
          AND wl.league_season_id = p_league_season_id
          AND wl.game_date = p_game_date
          AND wl.player_id = (a->>'player_id')::uuid
     );
END;
$function$;
