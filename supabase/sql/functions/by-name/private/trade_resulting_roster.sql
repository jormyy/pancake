-- Canonical SQL source for private.trade_resulting_roster.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.trade_resulting_roster(p_trade_id uuid,p_member_id uuid)
RETURNS TABLE(player_id uuid,on_ir boolean,on_taxi boolean)
LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT roster.player_id,
    CASE WHEN move.value IS NULL THEN roster.is_on_ir ELSE move.value->>'destination'='ir' END,
    CASE WHEN move.value IS NULL THEN roster.is_on_taxi ELSE move.value->>'destination'='taxi' END
  FROM trades trade JOIN trade_participants participant ON participant.trade_id=trade.id AND participant.member_id=p_member_id
  JOIN roster_players roster ON roster.league_season_id=trade.league_season_id AND roster.member_id=p_member_id
  LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(participant.roster_moves) WHERE value->>'playerId'=roster.player_id::text) move ON true
  WHERE trade.id=p_trade_id AND NOT roster.player_id=ANY(participant.drop_player_ids)
    AND NOT EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id=trade.id AND item.from_member_id=p_member_id AND item.player_id=roster.player_id)
  UNION ALL
  SELECT item.player_id,item.to_ir,item.to_taxi OR roster.is_on_taxi
  FROM trades trade JOIN trade_items item ON item.trade_id=trade.id AND item.to_member_id=p_member_id
  JOIN roster_players roster ON roster.league_season_id=trade.league_season_id AND roster.player_id=item.player_id
  WHERE trade.id=p_trade_id
$$;
