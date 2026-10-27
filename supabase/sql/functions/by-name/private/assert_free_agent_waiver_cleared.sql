CREATE OR REPLACE FUNCTION private.assert_free_agent_waiver_cleared(
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid
)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Every pickup requires a scheduled waiver claim. Submit a claim instead.' USING ERRCODE = 'PA002';
END;
$$;
