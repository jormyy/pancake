-- Canonical SQL source for private.trade_lock_keys.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.trade_lock_keys(p_trade_ids uuid[])
RETURNS TABLE (league_id uuid, kind int, id uuid)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT trade.league_id, key.kind, key.id
    FROM trades AS trade
    CROSS JOIN LATERAL (
      SELECT 1, participant.member_id FROM trade_participants AS participant WHERE participant.trade_id = trade.id
      UNION SELECT 2, item.player_id FROM trade_items AS item WHERE item.trade_id = trade.id
      UNION SELECT 2, unnest(participant.drop_player_ids) FROM trade_participants AS participant WHERE participant.trade_id = trade.id
      UNION SELECT 2, (move->>'playerId')::uuid
        FROM trade_participants AS participant, jsonb_array_elements(participant.roster_moves) AS move
       WHERE participant.trade_id = trade.id
    ) AS key(kind, id)
   WHERE trade.id = ANY(p_trade_ids)
     AND key.id IS NOT NULL;
$$;
