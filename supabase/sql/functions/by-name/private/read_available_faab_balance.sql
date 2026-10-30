-- Canonical SQL source for private.read_available_faab_balance.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.read_available_faab_balance(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS int
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT balance FROM public.faab_balances WHERE league_id=p_league_id
      AND league_season_id=p_league_season_id AND member_id=p_member_id),
    (SELECT faab_starting_budget FROM public.leagues WHERE id=p_league_id),100)
    - COALESCE((SELECT sum(item.faab_amount)::int
      FROM public.trade_items item JOIN public.trades trade ON trade.id=item.trade_id
      WHERE trade.league_id=p_league_id AND trade.league_season_id=p_league_season_id
        AND trade.status='accepted' AND item.from_member_id=p_member_id
        AND trade.id IS DISTINCT FROM p_exclude_trade_id),0);
$$;
