CREATE OR REPLACE FUNCTION private.validate_trade_rosters(p_trade_id uuid, p_only_member_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_league leagues%ROWTYPE; v_team record; v_count record;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  SELECT * INTO v_league FROM leagues WHERE id = v_trade.league_id FOR UPDATE;
  IF NOT v_league.allow_inactive_trades THEN RETURN; END IF;
  PERFORM 1 FROM players player
    WHERE player.id IN (SELECT player_id FROM trade_items WHERE trade_id=p_trade_id)
    ORDER BY player.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id=p_trade_id AND item.player_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id
      AND member_id=item.from_member_id AND player_id=item.player_id)) THEN
    RAISE EXCEPTION 'A trade player is no longer owned by the expected team.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN players player ON player.id = item.player_id
    WHERE item.trade_id = p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_ir AND
      (item.to_taxi OR NOT private.is_ir_designation(player.injury_status))) THEN
    RAISE EXCEPTION 'Incoming IR players must be Out or IR-designated and cannot also enter taxi.' USING ERRCODE = 'PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN players player ON player.id=item.player_id
    WHERE item.trade_id=p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id)
      AND item.to_taxi AND player.career_regular_season_games IS NULL
      AND NOT private.taxi_player_eligible(v_trade.league_id,item.player_id)) THEN
    RAISE EXCEPTION 'The career games count is not known yet. This player cannot enter taxi.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN roster_players roster
      ON roster.league_season_id = v_trade.league_season_id AND roster.player_id = item.player_id
    WHERE item.trade_id = p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_taxi
      AND NOT private.taxi_player_eligible(v_trade.league_id, item.player_id)) THEN
    RAISE EXCEPTION 'Incoming taxi players must be rookies or have fewer than 65 career regular-season games.' USING ERRCODE = 'PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN roster_players roster
    ON roster.league_season_id=v_trade.league_season_id AND roster.player_id=item.player_id
    JOIN league_seasons season ON season.id=roster.league_season_id
    WHERE item.trade_id=p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_taxi AND v_league.taxi_max_seasons IS NOT NULL
      AND season.season_year-private.taxi_start_year(v_trade.league_id,roster.player_id,season.season_year)>=v_league.taxi_max_seasons) THEN
    RAISE EXCEPTION 'Incoming taxi player has reached the taxi tenure limit.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN league_member_taxi_exits exit
    ON exit.league_id=v_trade.league_id AND exit.member_id=item.to_member_id AND exit.player_id=item.player_id
    WHERE item.trade_id=p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_taxi) THEN
    RAISE EXCEPTION 'A promoted player cannot return to this team taxi squad.' USING ERRCODE='PT001';
  END IF;
  FOR v_team IN SELECT participant.*, member.team_name FROM trade_participants participant
    JOIN league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = p_trade_id
      AND (p_only_member_id IS NULL OR participant.member_id = p_only_member_id)
    ORDER BY participant.member_id LOOP
    IF EXISTS (SELECT 1 FROM unnest(v_team.drop_player_ids) drop_choice(player_id) WHERE
      NOT EXISTS (SELECT 1 FROM roster_players roster WHERE roster.league_season_id = v_trade.league_season_id
        AND roster.member_id = v_team.member_id AND roster.player_id = drop_choice.player_id)
      OR EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id = p_trade_id AND item.player_id = drop_choice.player_id)
      OR private.is_reserved_trade_asset(v_trade.league_id, v_trade.league_season_id, v_team.member_id, drop_choice.player_id, NULL, p_trade_id)
      OR EXISTS (SELECT 1 FROM waiver_claims WHERE league_season_id=v_trade.league_season_id AND status='pending' AND drop_player_id=drop_choice.player_id)) THEN
      RAISE EXCEPTION 'A selected trade drop is missing, reserved, or included in the offer.' USING ERRCODE = 'PT001';
    END IF;
    SELECT count(*) AS total, count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
      count(*) FILTER (WHERE on_ir) AS ir, count(*) FILTER (WHERE on_taxi) AS taxi INTO v_count
    FROM (
      SELECT roster.is_on_ir AS on_ir, roster.is_on_taxi AS on_taxi FROM roster_players roster
      WHERE roster.league_season_id = v_trade.league_season_id AND roster.member_id = v_team.member_id
        AND NOT roster.player_id = ANY(v_team.drop_player_ids)
        AND NOT EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id = p_trade_id
          AND item.from_member_id = v_team.member_id AND item.player_id = roster.player_id)
      UNION ALL
      SELECT item.to_ir, item.to_taxi OR roster.is_on_taxi FROM trade_items item
      JOIN roster_players roster ON roster.league_season_id = v_trade.league_season_id AND roster.player_id = item.player_id
      WHERE item.trade_id = p_trade_id AND item.to_member_id = v_team.member_id
    ) resulting;
    IF v_count.total > v_league.roster_size + v_league.ir_slots + v_league.taxi_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the total roster limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.active > v_league.roster_size THEN
      RAISE EXCEPTION '% must change its trade plan to meet the active roster limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.ir > v_league.ir_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the IR limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.taxi > v_league.taxi_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the taxi limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
  END LOOP;
END;
$$;
