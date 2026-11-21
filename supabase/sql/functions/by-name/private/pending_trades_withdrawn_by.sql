-- Canonical SQL source for private.pending_trades_withdrawn_by.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.pending_trades_withdrawn_by(p_trade_id uuid)
RETURNS TABLE(trade_id uuid)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT other.id
    FROM trades source
    JOIN trade_items moved ON moved.trade_id = source.id
    JOIN trades other ON other.league_id = source.league_id
      AND other.league_season_id = source.league_season_id
      AND other.id <> source.id
      AND other.status = 'pending'
   WHERE source.id = p_trade_id
     AND (EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id = other.id
            AND (item.player_id = moved.player_id OR item.pick_id = moved.pick_id))
       OR EXISTS (SELECT 1 FROM trade_participants participant WHERE participant.trade_id = other.id
            AND (moved.player_id = ANY(participant.drop_player_ids)
              OR participant.roster_moves @> jsonb_build_array(jsonb_build_object('playerId', moved.player_id::text)))))
   GROUP BY other.id
$$;
