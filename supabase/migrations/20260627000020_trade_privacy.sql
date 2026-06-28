-- Hide private pending trade proposals from non-parties.
--
-- Accepted trades remain visible to league members so the veto window can work.
-- Pending and terminal trade rows/items are visible only to the proposer or
-- recipient through their own league_members rows.

DROP POLICY IF EXISTS "trades_select" ON public.trades;
DROP POLICY IF EXISTS "trades_select_parties_or_accepted" ON public.trades;

CREATE POLICY "trades_select_parties_or_accepted" ON public.trades
  FOR SELECT TO authenticated
  USING (
    league_id IN (SELECT private.my_league_ids())
    AND (
      status = 'accepted'::public.trade_status
      OR proposer_member_id IN (SELECT private.my_member_ids())
      OR recipient_member_id IN (SELECT private.my_member_ids())
    )
  );

DROP POLICY IF EXISTS "trade_items_select" ON public.trade_items;
DROP POLICY IF EXISTS "trade_items_select_parties_or_accepted" ON public.trade_items;

CREATE POLICY "trade_items_select_parties_or_accepted" ON public.trade_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.trades AS trade
      WHERE trade.id = trade_items.trade_id
        AND trade.league_id IN (SELECT private.my_league_ids())
        AND (
          trade.status = 'accepted'::public.trade_status
          OR trade.proposer_member_id IN (SELECT private.my_member_ids())
          OR trade.recipient_member_id IN (SELECT private.my_member_ids())
        )
    )
  );
