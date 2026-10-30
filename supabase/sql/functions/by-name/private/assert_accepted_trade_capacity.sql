-- Canonical SQL source for private.assert_accepted_trade_capacity.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_accepted_trade_capacity(p_league_id uuid,p_season_id uuid,p_member_id uuid,p_include_trade_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_counts record; v_league leagues%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trades trade JOIN trade_participants participant ON participant.trade_id=trade.id
    WHERE trade.league_id=p_league_id AND trade.league_season_id=p_season_id AND participant.member_id=p_member_id
      AND (trade.status='accepted' OR trade.id=p_include_trade_id)) THEN RETURN; END IF;
  SELECT * INTO v_league FROM leagues WHERE id=p_league_id;
  WITH commitments AS (
    SELECT trade.id,participant.drop_player_ids,participant.roster_moves
    FROM trades trade JOIN trade_participants participant ON participant.trade_id=trade.id AND participant.member_id=p_member_id
    WHERE trade.league_id=p_league_id AND trade.league_season_id=p_season_id AND (trade.status='accepted' OR trade.id=p_include_trade_id)
  ), resulting AS (
    SELECT CASE WHEN move.value IS NULL THEN roster.is_on_ir ELSE move.value->>'destination'='ir' END AS on_ir,
      CASE WHEN move.value IS NULL THEN roster.is_on_taxi ELSE move.value->>'destination'='taxi' END AS on_taxi
    FROM roster_players roster
    LEFT JOIN LATERAL (SELECT value FROM commitments,jsonb_array_elements(roster_moves) WHERE value->>'playerId'=roster.player_id::text) move ON true
    WHERE roster.league_season_id=p_season_id AND roster.member_id=p_member_id
      AND NOT EXISTS (SELECT 1 FROM commitments WHERE roster.player_id=ANY(drop_player_ids))
      AND NOT EXISTS (SELECT 1 FROM commitments JOIN trade_items item ON item.trade_id=commitments.id
        WHERE item.from_member_id=p_member_id AND item.player_id=roster.player_id)
    UNION ALL
    SELECT item.to_ir,item.to_taxi OR roster.is_on_taxi
    FROM commitments JOIN trade_items item ON item.trade_id=commitments.id AND item.to_member_id=p_member_id
    JOIN roster_players roster ON roster.league_season_id=p_season_id AND roster.player_id=item.player_id
  ) SELECT count(*) FILTER(WHERE NOT on_ir AND NOT on_taxi) active,count(*) FILTER(WHERE on_ir) ir,
      count(*) FILTER(WHERE on_taxi) taxi INTO v_counts FROM resulting;
  IF v_counts.active>v_league.roster_size OR v_counts.ir>v_league.ir_slots OR v_counts.taxi>v_league.taxi_slots THEN
    RAISE EXCEPTION 'Accepted trades reserve roster capacity. Change this action or resolve the trade first.' USING ERRCODE='PT409';
  END IF;
END;
$$;
