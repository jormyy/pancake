-- Canonical SQL source for private.assert_taxi_acquisition_allowed.
-- Keep the latest migration definition identical.

CREATE OR REPLACE FUNCTION private.assert_taxi_acquisition_allowed(
  p_league_id uuid, p_season_id uuid, p_member_id uuid, p_player_id uuid
)
RETURNS void LANGUAGE plpgsql SET search_path = public, private AS $$
DECLARE v_slots int; v_count int;
BEGIN
  IF EXISTS (SELECT 1 FROM league_member_taxi_exits WHERE league_id=p_league_id AND member_id=p_member_id AND player_id=p_player_id) THEN
    RAISE EXCEPTION 'This player has left your team''s taxi squad and cannot return to it, even after reacquisition or a season change.' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id=p_player_id AND years_exp=0 AND nba_draft_number IS NOT NULL) THEN
    RAISE EXCEPTION 'Only current rookies can be placed on the taxi squad.' USING ERRCODE='P0001';
  END IF;
  IF private.roster_status_game_started(p_player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.' USING ERRCODE='P0001';
  END IF;
  SELECT taxi_slots INTO v_slots FROM leagues WHERE id=p_league_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM roster_players
   WHERE league_id=p_league_id AND league_season_id=p_season_id AND member_id=p_member_id AND is_on_taxi;
  IF v_count >= COALESCE(v_slots,0) THEN
    RAISE EXCEPTION 'Your taxi squad is full (% slots).', COALESCE(v_slots,0) USING ERRCODE='P0001';
  END IF;
END;
$$;
