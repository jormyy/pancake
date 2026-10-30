-- Canonical SQL source for private.assert_taxi_acquisition_allowed.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_taxi_acquisition_allowed(
  p_league_id uuid, p_season_id uuid, p_member_id uuid, p_player_id uuid
)
RETURNS void LANGUAGE plpgsql SET search_path = public, private AS $$
DECLARE v_slots int; v_count int; v_held int:=0;
BEGIN
  IF EXISTS (SELECT 1 FROM league_member_taxi_exits WHERE league_id=p_league_id AND member_id=p_member_id AND player_id=p_player_id) THEN
    RAISE EXCEPTION 'This player has left your team''s taxi squad and cannot return to it, even after reacquisition or a season change.' USING ERRCODE='P0001';
  END IF;
  IF NOT private.taxi_player_eligible(p_league_id,p_player_id) THEN
    IF EXISTS (SELECT 1 FROM players WHERE id=p_player_id AND career_regular_season_games IS NULL) THEN
      RAISE EXCEPTION 'The career games count is not known yet. This player cannot enter taxi.' USING ERRCODE='P0001';
    END IF;
    RAISE EXCEPTION 'Taxi requires an NBA rookie or fewer than 65 career regular-season games.' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM leagues league JOIN league_seasons season ON season.id=p_season_id
    WHERE league.id=p_league_id AND league.taxi_max_seasons IS NOT NULL
      AND season.season_year-private.taxi_start_year(p_league_id,p_player_id,season.season_year)>=league.taxi_max_seasons) THEN
    RAISE EXCEPTION 'This player has reached the taxi tenure limit.' USING ERRCODE='P0001';
  END IF;
  IF private.roster_status_game_started(p_player_id) AND NOT EXISTS (
    SELECT 1 FROM private.taxi_acquisition_context c WHERE c.transaction_id=pg_current_xact_id()
      AND c.league_id=p_league_id AND c.league_season_id=p_season_id
      AND c.member_id=p_member_id AND c.player_id=p_player_id AND c.source IN ('free_agent','waiver')
  ) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.' USING ERRCODE='P0001';
  END IF;
  SELECT taxi_slots INTO v_slots FROM leagues WHERE id=p_league_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM roster_players
   WHERE league_id=p_league_id AND league_season_id=p_season_id AND member_id=p_member_id AND is_on_taxi;
  IF EXISTS (SELECT 1 FROM private.taxi_acquisition_context c
    WHERE c.transaction_id=pg_current_xact_id() AND c.league_id=p_league_id
      AND c.league_season_id=p_season_id AND c.member_id=p_member_id AND c.player_id=p_player_id
      AND c.source IN ('free_agent','waiver')) THEN
    SELECT count(*) INTO v_held FROM trade_items item JOIN trades trade ON trade.id=item.trade_id
      WHERE trade.league_id=p_league_id AND trade.league_season_id=p_season_id AND trade.status='accepted'
        AND item.to_member_id=p_member_id AND item.player_id IS NOT NULL AND item.to_taxi;
  END IF;
  IF v_count+v_held >= COALESCE(v_slots,0) AND v_held>0 THEN
    RAISE EXCEPTION 'Your taxi squad is full (% slots). Accepted trades hold % taxi slot(s).',COALESCE(v_slots,0),v_held USING ERRCODE='P0001';
  END IF;
  IF v_count >= COALESCE(v_slots,0) AND NOT EXISTS (SELECT 1 FROM private.taxi_acquisition_context c JOIN trades t ON t.id=c.related_id WHERE c.transaction_id=pg_current_xact_id() AND c.source='trade' AND c.player_id=p_player_id AND t.status='accepted' AND EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades)) THEN
    RAISE EXCEPTION 'Your taxi squad is full (% slots).', COALESCE(v_slots,0) USING ERRCODE='P0001';
  END IF;
END;
$$;
