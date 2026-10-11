-- trade_vetos_select read vetoes through `trade_id IN (SELECT t.id FROM trades t ...)`.
-- That subquery runs the trades read policy, private.can_read_trade(id), on
-- every row of trades for each query, so trade pages and veto realtime checks
-- slowed down as every league's trade history grew. Because of that policy the
-- effective rule was already private.can_read_trade(trade_id), the rule
-- trade_participants and trade_items use. Evaluate it per veto row instead.
DROP POLICY IF EXISTS "trade_vetos_select" ON public.trade_vetos;
CREATE POLICY "trade_vetos_select" ON public.trade_vetos
  FOR SELECT TO authenticated
  USING (private.can_read_trade(trade_id));
