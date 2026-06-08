-- Make set_player_slot_atomic authoritative for lineup slot legality.
--
-- The previous hardening made the RPC enforce started-game locks, but direct
-- authenticated callers could still place a player into an ineligible or full
-- starter slot before tipoff. Scoring counts every non-BE/non-IR lineup row, so
-- the database has to enforce the same slot rules the UI presents.

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
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_roster_id uuid;
  v_player_team text;
  v_player_name text;
  v_player_positions text[] := '{}'::text[];
  v_is_on_ir boolean := false;
  v_is_on_taxi boolean := false;
  v_locked_slot_player text;
  v_slot_count int;
  v_existing_slot_count int;
  v_allowed_positions text[];
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

  SELECT
      rp.id,
      p.nba_team,
      p.display_name,
      CASE
        WHEN cardinality(COALESCE(p.eligible_positions, '{}'::text[])) > 0
          THEN p.eligible_positions
        WHEN p.position IS NOT NULL
          THEN ARRAY[p.position::text]::text[]
        ELSE '{}'::text[]
      END,
      rp.is_on_ir,
      COALESCE(rp.is_on_taxi, false)
    INTO
      v_roster_id,
      v_player_team,
      v_player_name,
      v_player_positions,
      v_is_on_ir,
      v_is_on_taxi
    FROM roster_players rp
    JOIN players p ON p.id = rp.player_id
   WHERE rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.player_id = p_player_id
   FOR SHARE OF rp;

  IF v_roster_id IS NULL THEN
    RAISE EXCEPTION 'Player is no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_player_team IS NOT NULL AND EXISTS (
    SELECT 1
      FROM nba_games g
     WHERE g.game_date = p_game_date
       AND (g.home_team = v_player_team OR g.away_team = v_player_team)
       AND (
         g.status IN ('InProgress', 'Final')
         OR (g.game_time IS NOT NULL AND g.game_time <= now())
       )
  ) THEN
    RAISE EXCEPTION 'Lineup changes are locked after the player''s game has started.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_slot_type <> 'BE'::roster_slot_type THEN
    IF p_slot_type = 'IR'::roster_slot_type THEN
      RAISE EXCEPTION 'Use the roster injured reserve action instead of assigning an IR lineup slot.'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_is_on_ir OR v_is_on_taxi THEN
      RAISE EXCEPTION 'Activate the player before assigning a starter slot.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT slot_count
      INTO v_slot_count
      FROM lineup_slot_templates
     WHERE league_id = p_league_id
       AND slot_type = p_slot_type
       AND slot_type NOT IN ('BE'::roster_slot_type, 'IR'::roster_slot_type);

    IF v_slot_count IS NULL THEN
      RAISE EXCEPTION 'Lineup slot % is not configured for this league.', p_slot_type
        USING ERRCODE = 'P0001';
    END IF;

    v_allowed_positions := public.lineup_slot_allowed_positions(p_slot_type);

    IF NOT (v_player_positions && v_allowed_positions) THEN
      RAISE EXCEPTION '% is not eligible for %.', COALESCE(v_player_name, 'Player'), p_slot_type
        USING ERRCODE = 'P0001';
    END IF;

    SELECT locked_player.display_name
      INTO v_locked_slot_player
      FROM weekly_lineups wl
      JOIN players locked_player ON locked_player.id = wl.player_id
      JOIN nba_games g
        ON g.game_date = wl.game_date
       AND (g.home_team = locked_player.nba_team OR g.away_team = locked_player.nba_team)
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND wl.slot_type = p_slot_type
       AND wl.player_id <> p_player_id
       AND (
         g.status IN ('InProgress', 'Final')
         OR (g.game_time IS NOT NULL AND g.game_time <= now())
       )
     LIMIT 1;

    IF v_locked_slot_player IS NOT NULL THEN
      RAISE EXCEPTION 'Lineup changes are locked because %''s game has already started.', v_locked_slot_player
        USING ERRCODE = 'P0001';
    END IF;

    SELECT COUNT(*)
      INTO v_existing_slot_count
      FROM weekly_lineups wl
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND wl.slot_type = p_slot_type
       AND wl.player_id <> p_player_id;

    IF v_existing_slot_count >= v_slot_count THEN
      RAISE EXCEPTION 'Lineup slot % is full.', p_slot_type
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_slot_type = 'BE'::roster_slot_type THEN
    DELETE FROM weekly_lineups
     WHERE member_id = p_member_id
       AND league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND player_id = p_player_id
       AND game_date = p_game_date;
  ELSE
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
    VALUES (
      p_member_id,
      p_league_id,
      p_league_season_id,
      p_player_id,
      p_week_number,
      p_game_date,
      p_slot_type,
      false,
      now()
    )
    ON CONFLICT (league_id, league_season_id, member_id, player_id, game_date)
    DO UPDATE SET
      slot_type = EXCLUDED.slot_type,
      week_number = EXCLUDED.week_number,
      is_auto_set = EXCLUDED.is_auto_set,
      set_at = EXCLUDED.set_at;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) TO service_role;
