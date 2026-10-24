CREATE OR REPLACE FUNCTION private.available_faab_balance(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_balance int;
  v_reserved int;
BEGIN
  v_balance := private.ensure_faab_balance(p_league_id, p_league_season_id, p_member_id);
  SELECT COALESCE(sum(item.faab_amount), 0)::int INTO v_reserved
    FROM trade_items AS item
    JOIN trades AS trade ON trade.id = item.trade_id
   WHERE trade.league_id = p_league_id
     AND trade.league_season_id = p_league_season_id
     AND trade.status = 'accepted'
     AND item.from_member_id = p_member_id
     AND trade.id IS DISTINCT FROM p_exclude_trade_id;
  RETURN v_balance - v_reserved;
END;
$$;
