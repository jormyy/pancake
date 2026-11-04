-- Canonical SQL source for public.set_lineup_player_pin.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.set_lineup_player_pin(p_league_id uuid, p_player_id uuid, p_date date, p_pin text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_member_id uuid;
  v_season_id uuid;
  v_today date;
  v_roster public.roster_players%ROWTYPE;
BEGIN
  SELECT m.id, s.id, (now() AT TIME ZONE COALESCE(l.timezone, 'America/Los_Angeles'))::date
    INTO v_member_id, v_season_id, v_today
    FROM public.league_members m
    JOIN public.leagues l ON l.id = m.league_id AND l.deleted_at IS NULL
    JOIN public.league_seasons s ON s.league_id = l.id AND s.is_current
    WHERE m.league_id = p_league_id AND m.user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.' USING ERRCODE = '42501';
  END IF;
  IF p_date IS NULL OR (p_pin IS NOT NULL AND p_pin NOT IN ('start', 'bench')) THEN
    RAISE EXCEPTION 'Choose Start, Auto, or Bench for a lineup date.' USING ERRCODE = '22023';
  END IF;
  IF p_date < v_today THEN
    RAISE EXCEPTION 'Past lineups cannot be changed.' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_member_id::text));
  PERFORM pg_advisory_xact_lock(hashtext(v_member_id::text), hashtext(p_date::text));
  PERFORM public.assert_current_league_season_for_lineup(p_league_id, v_season_id);
  SELECT * INTO v_roster FROM public.roster_players
    WHERE league_id = p_league_id AND league_season_id = v_season_id
      AND member_id = v_member_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This player is no longer on your roster.' USING ERRCODE = 'P0002';
  END IF;
  IF v_roster.is_on_ir OR v_roster.is_on_taxi THEN
    RAISE EXCEPTION 'Activate this player before setting a lineup pin.' USING ERRCODE = 'P0001';
  END IF;
  IF private.lineup_game_started(p_player_id, p_date) THEN
    RAISE EXCEPTION 'Lineup changes are locked after this player''s game has started.' USING ERRCODE = 'P0001';
  END IF;
  IF p_pin IS NULL THEN
    DELETE FROM public.lineup_player_pins WHERE league_id = p_league_id AND league_season_id = v_season_id
      AND member_id = v_member_id AND player_id = p_player_id AND game_date = p_date;
  ELSE
    INSERT INTO public.lineup_player_pins(league_id, league_season_id, member_id, player_id, game_date, pin)
      VALUES (p_league_id, v_season_id, v_member_id, p_player_id, p_date, p_pin)
      ON CONFLICT (league_id, league_season_id, member_id, player_id, game_date)
      DO UPDATE SET pin = EXCLUDED.pin WHERE lineup_player_pins.pin IS DISTINCT FROM EXCLUDED.pin;
  END IF;
  RETURN jsonb_build_object('playerId', p_player_id, 'date', p_date, 'lineupPin', p_pin);
END;
$$;
