-- Canonical SQL source for private.assert_lineup_player_pins.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_lineup_player_pins(
  p_league_id uuid, p_league_season_id uuid, p_member_id uuid, p_game_date date, p_assignments jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.lineup_player_pins
    WHERE league_id = p_league_id AND league_season_id = p_league_season_id
      AND member_id = p_member_id AND game_date = p_game_date) THEN RETURN; END IF;
  IF EXISTS (
    WITH assignments AS MATERIALIZED (
      SELECT (a->>'player_id')::uuid AS player_id, (a->>'slot_type')::public.roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) a WHERE a->>'slot_type' NOT IN ('BE', 'IR')
    ), roster AS MATERIALIZED (
      SELECT p.id, p.nba_team, p.injury_status, pin.pin,
        COALESCE(NULLIF(p.eligible_positions, '{}'::text[]), ARRAY[p.position::text]) AS positions
      FROM public.roster_players rp JOIN public.players p ON p.id = rp.player_id
      LEFT JOIN public.lineup_player_pins pin ON pin.league_id = rp.league_id
        AND pin.league_season_id = rp.league_season_id AND pin.member_id = rp.member_id
        AND pin.player_id = rp.player_id AND pin.game_date = p_game_date
      WHERE rp.league_id = p_league_id AND rp.league_season_id = p_league_season_id
        AND rp.member_id = p_member_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
        AND NOT private.lineup_game_started(p.id, p_game_date)
    )
    SELECT 1 FROM assignments a JOIN roster starter ON starter.id = a.player_id
      JOIN roster reserve ON reserve.id <> starter.id
        AND reserve.positions && public.lineup_slot_allowed_positions(a.slot_type)
    WHERE NOT EXISTS (SELECT 1 FROM assignments used WHERE used.player_id = reserve.id)
      AND ((starter.pin = 'bench' AND reserve.pin IS DISTINCT FROM 'bench')
        OR (starter.pin IS DISTINCT FROM 'start' AND reserve.pin = 'start'
          AND COALESCE(lower(reserve.injury_status), '') <> 'out'
          AND COALESCE(lower(reserve.injury_status), '') NOT LIKE 'ir%'
          AND EXISTS (SELECT 1 FROM public.nba_games g WHERE g.game_date = p_game_date
            AND private.lineup_game_available(g.status, g.game_status_text)
            AND (g.home_team = reserve.nba_team OR g.away_team = reserve.nba_team))))
  ) THEN
    RAISE EXCEPTION 'Lineup pins changed; retry with fresh players.' USING ERRCODE = '40001';
  END IF;
END;
$$;
