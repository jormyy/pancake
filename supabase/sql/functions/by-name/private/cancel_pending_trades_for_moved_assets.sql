-- Canonical SQL source for private.cancel_pending_trades_for_moved_assets.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.cancel_pending_trades_for_moved_assets(p_trade_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_other record; v_previous_flag text;
BEGIN
  v_previous_flag := private.begin_trade_lifecycle_write();
  FOR v_other IN
    SELECT other.id, bool_or(moved.pick_id IS NOT NULL) AS non_player
    FROM public.trades source JOIN public.trade_items moved ON moved.trade_id=source.id
    JOIN public.trades other ON other.league_id=source.league_id
      AND other.league_season_id=source.league_season_id AND other.id<>source.id AND other.status='pending'
    WHERE source.id=p_trade_id AND source.status IN ('accepted','completed')
      AND (EXISTS(SELECT 1 FROM public.trade_items item WHERE item.trade_id=other.id
        AND (item.player_id=moved.player_id OR item.pick_id=moved.pick_id))
        OR EXISTS(SELECT 1 FROM public.trade_participants participant WHERE participant.trade_id=other.id
          AND (moved.player_id=ANY(participant.drop_player_ids)
            OR participant.roster_moves @> jsonb_build_array(jsonb_build_object('playerId',moved.player_id::text)))))
    GROUP BY other.id ORDER BY other.id
  LOOP
    UPDATE public.trades SET status='withdrawn',completion_failure_reason=CASE
      WHEN v_other.non_player THEN 'An asset in this offer was traded' ELSE 'A player in this offer was traded' END
    WHERE id=v_other.id AND status='pending';
  END LOOP;
  PERFORM private.end_trade_lifecycle_write(v_previous_flag);
END;
$$;
