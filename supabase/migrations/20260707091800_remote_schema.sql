-- Captured from production migration history (20260707091800) to reconcile repo/prod drift.
-- These fixes were applied directly to prod and were missing from the repo.

alter table "public"."drafts" drop constraint "drafts_pause_reason_known";
alter table "public"."drafts" add constraint "drafts_pause_reason_known" CHECK (((pause_reason IS NULL) OR (pause_reason = ANY (ARRAY['manual'::text, 'timer_expired_pause'::text, 'timer_expired_commissioner_pick'::text, 'member_absent'::text])))) not valid;
alter table "public"."drafts" validate constraint "drafts_pause_reason_known";
set check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.pause_draft_for_absence_atomic(p_draft_id uuid, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draft            drafts%ROWTYPE;
  v_remaining_seconds int;
BEGIN
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;

  -- No-op: already paused for absence (multiple clients converge here)
  IF v_draft.status = 'paused' AND v_draft.pause_reason = 'member_absent' THEN
    RETURN;
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Only an in-progress draft can be paused.';
  END IF;

  IF v_draft.draft_type <> 'auction' THEN
    RAISE EXCEPTION 'Presence-pause only applies to auction drafts.';
  END IF;

  -- Freeze countdown and record remaining seconds
  SELECT GREATEST(CEIL(EXTRACT(EPOCH FROM (countdown_expires_at - now())))::int, 0)
    INTO v_remaining_seconds
    FROM nominations
   WHERE draft_id = p_draft_id
     AND status   = 'open'
     AND countdown_expires_at IS NOT NULL
   ORDER BY nominated_at DESC
   LIMIT 1
   FOR UPDATE;

  UPDATE nominations
     SET countdown_expires_at = NULL
   WHERE draft_id = p_draft_id
     AND status   = 'open';

  UPDATE drafts
     SET status                        = 'paused',
         paused_at                     = now(),
         timer_paused_remaining_seconds = v_remaining_seconds,
         pause_reason                  = 'member_absent'
   WHERE id = p_draft_id;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'pause',
    jsonb_build_object('reason', 'member_absent', 'remainingSeconds', v_remaining_seconds)
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.resume_draft_if_absent_atomic(p_draft_id uuid, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draft      drafts%ROWTYPE;
  v_new_expiry timestamptz;
BEGIN
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;

  -- Only resume member_absent pauses; leave manual/timer pauses alone
  IF v_draft.status <> 'paused' OR v_draft.pause_reason IS DISTINCT FROM 'member_absent' THEN
    RETURN;
  END IF;

  -- Restore countdown if there were seconds remaining
  IF v_draft.timer_paused_remaining_seconds IS NOT NULL
     AND v_draft.timer_paused_remaining_seconds > 0 THEN
    v_new_expiry := now() + (v_draft.timer_paused_remaining_seconds * interval '1 second');
    UPDATE nominations
       SET countdown_expires_at = v_new_expiry
     WHERE draft_id = p_draft_id
       AND status   = 'open';
  END IF;

  UPDATE drafts
     SET status                        = 'in_progress',
         paused_at                     = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason                  = NULL
   WHERE id = p_draft_id;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'resume',
    jsonb_build_object('reason', 'member_absent_rejoined')
  );
END;
$function$;
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
$function$;
CREATE OR REPLACE FUNCTION public.drop_player_atomic(p_roster_player_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_clears_at timestamptz := now() + interval '48 hours';
  v_rows int;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_player_id::text)
  );

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM v_member.id;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.player_id = v_rp.player_id
       AND trade.league_id = v_rp.league_id
       AND trade.league_season_id = v_rp.league_season_id
       AND (
         (item.side = 'proposer' AND trade.proposer_member_id = v_rp.member_id)
         OR (item.side = 'recipient' AND trade.recipient_member_id = v_rp.member_id)
       )
  ) THEN
    RAISE EXCEPTION 'Player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = v_rp.id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as a drop for an accepted trade.'
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM roster_players
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM weekly_lineups wl
   WHERE wl.league_id = v_rp.league_id
     AND wl.league_season_id = v_rp.league_season_id
     AND wl.member_id = v_rp.member_id
     AND wl.player_id = v_rp.player_id
     AND wl.game_date >= (now() AT TIME ZONE 'America/New_York')::date
     AND NOT EXISTS (
       SELECT 1
         FROM players p
         JOIN nba_games g
           ON g.game_date = wl.game_date
          AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
        WHERE p.id = wl.player_id
          AND (
            g.status IN ('InProgress', 'Final')
            OR (g.game_time IS NOT NULL AND g.game_time <= now())
            OR (g.started_at IS NOT NULL AND g.started_at <= now())
          )
     );

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id,
    clears_at
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.player_id,
    v_rp.member_id,
    v_clears_at
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    'fa_drop'
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.join_league_by_invite_code(p_invite_code text, p_team_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_league           public.leagues%ROWTYPE;
  v_user_id          uuid := (SELECT auth.uid());
  v_invite_code      text := upper(trim(coalesce(p_invite_code, '')));
  v_existing         uuid;
  v_member_id        uuid;
  v_member_count     int;
  v_league_season_id uuid;
  v_season_year      int;
  v_priority         int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_invite_code !~ '^[A-Z0-9]{16}$' THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  SELECT *
  INTO   v_league
  FROM   public.leagues
  WHERE  invite_code = v_invite_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  IF v_league.status IS DISTINCT FROM 'setup'::public.league_status THEN
    RAISE EXCEPTION 'This league is no longer accepting new members.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
  INTO   v_existing
  FROM   public.league_members
  WHERE  league_id = v_league.id
    AND  user_id   = v_user_id;

  IF FOUND THEN
    RAISE EXCEPTION 'You are already in this league.';
  END IF;

  PERFORM v_existing;

  SELECT count(*)
  INTO   v_member_count
  FROM   public.league_members
  WHERE  league_id = v_league.id;

  IF v_member_count >= 10 THEN
    RAISE EXCEPTION 'This league is full.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, season_year
  INTO   v_league_season_id, v_season_year
  FROM   public.league_seasons
  WHERE  league_id = v_league.id
    AND  is_current = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League has no active season.';
  END IF;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league.id, v_user_id, 'manager', trim(p_team_name))
  RETURNING id INTO v_member_id;

  SELECT COALESCE(max(wp.priority), 0) + 1
  INTO   v_priority
  FROM   public.waiver_priorities AS wp
  WHERE  wp.league_id = v_league.id
    AND  wp.league_season_id = v_league_season_id;

  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league.id, v_league_season_id, v_member_id, v_priority);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league.id, year_value, round_value, v_member_id, v_member_id
  FROM generate_series(v_season_year + 1, v_season_year + 5) AS year_value
  CROSS JOIN generate_series(1, 3) AS round_value
  ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING;

  RETURN jsonb_build_object(
    'id',     v_league.id,
    'name',   v_league.name,
    'status', v_league.status
  );
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
$function$;
CREATE OR REPLACE FUNCTION public.toggle_ir_atomic(p_roster_player_id uuid, p_to_ir boolean, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_injury text;
  v_roster_size int;
  v_ir_slots int;
  v_other_ir_count int;
  v_active_count int;
  v_rows int;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_player_id::text)
  );

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.player_id = v_rp.player_id
       AND trade.league_id = v_rp.league_id
       AND trade.league_season_id = v_rp.league_season_id
       AND (
         (item.side = 'proposer' AND trade.proposer_member_id = v_rp.member_id)
         OR (item.side = 'recipient' AND trade.recipient_member_id = v_rp.member_id)
       )
  ) THEN
    RAISE EXCEPTION 'Player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = v_rp.id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as a drop for an accepted trade.'
      USING ERRCODE = 'P0001';
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

  IF p_to_ir THEN
    SELECT p.injury_status
      INTO v_injury
      FROM players p
     WHERE p.id = v_rp.player_id;

    IF NOT (
      lower(COALESCE(v_injury, '')) = 'out'
      OR lower(COALESCE(v_injury, '')) LIKE 'ir%'
    ) THEN
      RAISE EXCEPTION 'Only players with Out or IR designations can be placed on IR.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*)
      INTO v_other_ir_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = true
       AND id <> p_roster_player_id;

    IF v_other_ir_count >= v_ir_slots THEN
      RAISE EXCEPTION 'You only have % IR slot%.', v_ir_slots, CASE WHEN v_ir_slots = 1 THEN '' ELSE 's' END
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = false
       AND is_on_taxi = false
       AND id <> p_roster_player_id;

    IF v_active_count >= v_roster_size THEN
      RAISE EXCEPTION 'Your active roster is full (% players).', v_roster_size
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE roster_players
     SET is_on_ir = p_to_ir,
         is_on_taxi = CASE WHEN p_to_ir THEN false ELSE is_on_taxi END
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle IR status'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_to_ir THEN
    DELETE FROM weekly_lineups
     WHERE member_id = v_rp.member_id
       AND league_id = v_rp.league_id
       AND league_season_id = v_rp.league_season_id
       AND player_id = v_rp.player_id
       AND game_date >= (now() AT TIME ZONE 'America/New_York')::date;
  END IF;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    CASE WHEN p_to_ir THEN 'ir_designate' ELSE 'ir_return' END
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.toggle_taxi_atomic(p_roster_player_id uuid, p_to_taxi boolean, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_draft_number int;
  v_years_exp int;
  v_roster_size int;
  v_taxi_slots int;
  v_other_taxi_count int;
  v_active_count int;
  v_rows int;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_player_id::text)
  );

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.player_id = v_rp.player_id
       AND trade.league_id = v_rp.league_id
       AND trade.league_season_id = v_rp.league_season_id
       AND (
         (item.side = 'proposer' AND trade.proposer_member_id = v_rp.member_id)
         OR (item.side = 'recipient' AND trade.recipient_member_id = v_rp.member_id)
       )
  ) THEN
    RAISE EXCEPTION 'Player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = v_rp.id
  ) THEN
    RAISE EXCEPTION 'Player is reserved as a drop for an accepted trade.'
      USING ERRCODE = 'P0001';
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_taxi_slots := COALESCE(v_league.taxi_slots, 0);

  IF p_to_taxi THEN
    IF v_rp.is_on_ir THEN
      RAISE EXCEPTION 'Activate the player from IR before moving them to taxi.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT p.nba_draft_number, p.years_exp
      INTO v_draft_number, v_years_exp
      FROM players p
     WHERE p.id = v_rp.player_id;

    IF v_draft_number IS NULL OR v_years_exp IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Only current rookies can be placed on the taxi squad.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*)
      INTO v_other_taxi_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_taxi = true
       AND id <> p_roster_player_id;

    IF v_other_taxi_count >= v_taxi_slots THEN
      RAISE EXCEPTION 'You only have % taxi squad slot%.', v_taxi_slots, CASE WHEN v_taxi_slots = 1 THEN '' ELSE 's' END
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = false
       AND is_on_taxi = false
       AND id <> p_roster_player_id;

    IF v_active_count >= v_roster_size THEN
      RAISE EXCEPTION 'Your active roster is full (% players).', v_roster_size
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE roster_players
     SET is_on_taxi = p_to_taxi
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle taxi status'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_to_taxi THEN
    DELETE FROM weekly_lineups
     WHERE member_id = v_rp.member_id
       AND league_id = v_rp.league_id
       AND league_season_id = v_rp.league_season_id
       AND player_id = v_rp.player_id
       AND game_date >= (now() AT TIME ZONE 'America/New_York')::date;
  END IF;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    CASE WHEN p_to_taxi THEN 'taxi_designate' ELSE 'taxi_return' END
  );
END;
$function$;
grant select on table "public"."bids" to "anon";
grant select on table "public"."bids" to "authenticated";
grant select on table "public"."draft_audit_logs" to "anon";
grant delete on table "public"."draft_audit_logs" to "service_role";
grant update on table "public"."draft_audit_logs" to "service_role";
grant select on table "public"."draft_budgets" to "anon";
grant select on table "public"."draft_budgets" to "authenticated";
grant select on table "public"."draft_orders" to "anon";
grant select on table "public"."draft_orders" to "authenticated";
grant select on table "public"."draft_picks" to "anon";
grant select on table "public"."draft_picks" to "authenticated";
grant select on table "public"."draft_room_members" to "anon";
grant select on table "public"."draft_room_members" to "authenticated";
grant delete on table "public"."draft_room_members" to "service_role";
grant insert on table "public"."draft_room_members" to "service_role";
grant update on table "public"."draft_room_members" to "service_role";
grant select on table "public"."drafts" to "anon";
grant select on table "public"."drafts" to "authenticated";
grant select on table "public"."dynasty_news" to "anon";
grant select on table "public"."dynasty_rankings" to "anon";
grant select on table "public"."faab_balances" to "anon";
grant delete on table "public"."faab_balances" to "service_role";
grant insert on table "public"."faab_balances" to "service_role";
grant update on table "public"."faab_balances" to "service_role";
grant select on table "public"."league_activity" to "anon";
grant delete on table "public"."league_activity" to "service_role";
grant insert on table "public"."league_activity" to "service_role";
grant update on table "public"."league_activity" to "service_role";
grant delete on table "public"."league_audit_logs" to "service_role";
grant insert on table "public"."league_audit_logs" to "service_role";
grant update on table "public"."league_audit_logs" to "service_role";
grant select on table "public"."league_members" to "anon";
grant select on table "public"."league_members" to "authenticated";
grant select on table "public"."league_seasons" to "anon";
grant select on table "public"."league_seasons" to "authenticated";
grant select on table "public"."leagues" to "anon";
grant select on table "public"."leagues" to "authenticated";
grant select on table "public"."lineup_optimizer_settings" to "anon";
grant select on table "public"."lineup_optimizer_settings" to "authenticated";
grant delete on table "public"."lineup_optimizer_settings" to "service_role";
grant insert on table "public"."lineup_optimizer_settings" to "service_role";
grant update on table "public"."lineup_optimizer_settings" to "service_role";
grant select on table "public"."lineup_slot_templates" to "anon";
grant select on table "public"."lineup_slot_templates" to "authenticated";
grant select on table "public"."live_poll_leases" to "anon";
grant select on table "public"."live_poll_leases" to "authenticated";
grant select on table "public"."matchups" to "anon";
grant select on table "public"."matchups" to "authenticated";
grant select on table "public"."nba_games" to "anon";
grant select on table "public"."nba_games" to "authenticated";
grant select on table "public"."nominations" to "anon";
grant select on table "public"."nominations" to "authenticated";
grant select on table "public"."notification_preferences" to "anon";
grant delete on table "public"."notification_preferences" to "service_role";
grant insert on table "public"."notification_preferences" to "service_role";
grant update on table "public"."notification_preferences" to "service_role";
grant select on table "public"."player_game_stats" to "anon";
grant select on table "public"."player_game_stats" to "authenticated";
grant select on table "public"."player_projections" to "anon";
grant select on table "public"."player_projections" to "authenticated";
grant select on table "public"."players" to "anon";
grant select on table "public"."players" to "authenticated";
grant select on table "public"."roster_players" to "anon";
grant select on table "public"."roster_players" to "authenticated";
grant select on table "public"."roster_transactions" to "anon";
grant select on table "public"."roster_transactions" to "authenticated";
grant select on table "public"."rps_challenges" to "anon";
grant select on table "public"."rps_challenges" to "authenticated";
grant select on table "public"."season_weeks" to "anon";
grant select on table "public"."season_weeks" to "authenticated";
grant select on table "public"."snake_draft_picks" to "anon";
grant select on table "public"."snake_draft_picks" to "authenticated";
grant select on table "public"."standings" to "anon";
grant select on table "public"."standings" to "authenticated";
grant select on table "public"."trade_block_items" to "anon";
grant delete on table "public"."trade_block_items" to "service_role";
grant insert on table "public"."trade_block_items" to "service_role";
grant update on table "public"."trade_block_items" to "service_role";
grant select on table "public"."trade_items" to "anon";
grant select on table "public"."trade_items" to "authenticated";
grant select on table "public"."trade_vetos" to "anon";
grant select on table "public"."trade_vetos" to "authenticated";
grant select on table "public"."trades" to "anon";
grant select on table "public"."trades" to "authenticated";
grant select on table "public"."waiver_claims" to "anon";
grant select on table "public"."waiver_claims" to "authenticated";
grant select on table "public"."waiver_priorities" to "anon";
grant select on table "public"."waiver_priorities" to "authenticated";
grant select on table "public"."waiver_wire_log" to "anon";
grant select on table "public"."waiver_wire_log" to "authenticated";
grant select on table "public"."weekly_add_counts" to "anon";
grant delete on table "public"."weekly_add_counts" to "service_role";
grant insert on table "public"."weekly_add_counts" to "service_role";
grant update on table "public"."weekly_add_counts" to "service_role";
grant select on table "public"."weekly_lineups" to "anon";
grant select on table "public"."weekly_lineups" to "authenticated";
drop policy "avatars_delete_own" on "storage"."objects";
drop policy "avatars_insert_own" on "storage"."objects";
drop policy "avatars_read_public" on "storage"."objects";
drop policy "avatars_update_own" on "storage"."objects";
