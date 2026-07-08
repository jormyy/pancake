-- Prevent trade visibility policies from recursively evaluating each other.
--
-- Multi-team trade visibility needs both public.trades and
-- public.trade_participants. Calling this SECURITY DEFINER helper from RLS
-- policies keeps that cross-table lookup in one owner-executed predicate,
-- instead of making trades policies read participant rows whose own policy
-- reads trades again.

CREATE OR REPLACE FUNCTION private.can_read_trade(p_trade_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.trades AS trade
     WHERE trade.id = p_trade_id
       AND trade.league_id IN (SELECT private.my_league_ids())
       AND (
         trade.status = 'accepted'::public.trade_status
         OR trade.proposer_member_id IN (SELECT private.my_member_ids())
         OR trade.recipient_member_id IN (SELECT private.my_member_ids())
         OR EXISTS (
           SELECT 1
             FROM public.trade_participants AS participant
            WHERE participant.trade_id = trade.id
              AND participant.member_id IN (SELECT private.my_member_ids())
         )
       )
  )
$$;

DROP POLICY IF EXISTS "trades_select_parties_or_accepted" ON public.trades;
CREATE POLICY "trades_select_parties_or_accepted" ON public.trades
  FOR SELECT TO authenticated
  USING (private.can_read_trade(id));

DROP POLICY IF EXISTS "trade_participants_select_parties_or_accepted" ON public.trade_participants;
CREATE POLICY "trade_participants_select_parties_or_accepted" ON public.trade_participants
  FOR SELECT TO authenticated
  USING (private.can_read_trade(trade_id));

DROP POLICY IF EXISTS "trade_items_select_parties_or_accepted" ON public.trade_items;
CREATE POLICY "trade_items_select_parties_or_accepted" ON public.trade_items
  FOR SELECT TO authenticated
  USING (private.can_read_trade(trade_id));
