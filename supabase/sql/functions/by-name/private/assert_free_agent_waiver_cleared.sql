CREATE OR REPLACE FUNCTION private.assert_free_agent_waiver_cleared(
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.waiver_wire_log AS waiver
     WHERE waiver.league_id = p_league_id
       AND waiver.league_season_id = p_league_season_id
       AND waiver.player_id = p_player_id
       AND waiver.cleared_at IS NULL
  ) THEN
    RAISE EXCEPTION 'This player is on waivers - submit a waiver claim instead.'
      USING ERRCODE = 'PA002';
  END IF;
END;
$$;
