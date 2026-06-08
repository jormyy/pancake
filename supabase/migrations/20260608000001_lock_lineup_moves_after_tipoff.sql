-- Enforce lineup locks inside the public set_player_slot_atomic RPC.
--
-- Client code already prevents moves involving teams whose game has started,
-- but authenticated users can call this granted SECURITY DEFINER RPC directly.
-- This version makes the database authoritative:
--   * A player cannot be moved after that player's NBA game has started.
--   * A player cannot be moved into a starter slot type that currently
--     contains another locked player. weekly_lineups has no slot index, only
--     slot_type, so this intentionally locks the whole slot type once any
--     occupant in that slot type is locked.
-- "Started" includes explicit live/final statuses and scheduled games whose
-- game_time is already in the past, matching the app's auto-set logic.

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
  v_locked_slot_player text;
BEGIN
  -- Serialize every lineup mutation on (member_id, game_date). Two devices
  -- firing setPlayerSlot / autoSet for the same day will queue.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_member_id::text),
    hashtext(p_game_date::text)
  );

  -- Re-verify caller ownership. Mirrors the weekly_lineups RLS policies
  -- we bypass via SECURITY DEFINER.
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

  -- Lock the leagues row and gate on status. Lineups are only meaningful
  -- once the season is in-flight ('active' / 'playoffs').
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

  -- Re-verify the member currently owns this player. FOR SHARE blocks
  -- against a concurrent drop_player_atomic / accept_trade_atomic /
  -- process_next_waiver_claim_atomic SELECT FOR UPDATE on the same row,
  -- so the check cannot be stale at commit time.
  SELECT rp.id, p.nba_team
    INTO v_roster_id, v_player_team
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
  END IF;

  IF p_slot_type = 'BE'::roster_slot_type THEN
    -- Bench is implicit: no row means bench. Match the prior client
    -- behavior of DELETE-on-bench.
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
