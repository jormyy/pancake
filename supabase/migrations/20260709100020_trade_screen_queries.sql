-- Apply member visibility before pagination so unrelated league history cannot
-- displace a manager's pending offers or trade history.
CREATE OR REPLACE FUNCTION public.get_trades_for_member(
  p_member_id uuid,
  p_league_id uuid,
  p_limit int DEFAULT 40,
  p_offset int DEFAULT 0
)
RETURNS SETOF public.trades
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT trade.*
    FROM public.trades AS trade
   WHERE trade.league_id = p_league_id
     AND p_member_id IN (SELECT private.my_member_ids())
     AND p_league_id IN (SELECT private.my_league_ids())
     AND (
       trade.proposer_member_id = p_member_id
       OR trade.recipient_member_id = p_member_id
       OR EXISTS (
         SELECT 1
           FROM public.trade_participants AS participant
          WHERE participant.trade_id = trade.id
            AND participant.member_id = p_member_id
       )
       OR (
         trade.status = 'accepted'::public.trade_status
         AND trade.veto_window_expires_at > now()
       )
     )
   ORDER BY trade.proposed_at DESC, trade.id DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
$$;

CREATE OR REPLACE FUNCTION public.get_pending_trade_count(
  p_member_id uuid,
  p_league_id uuid
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT count(*)
    FROM public.trades AS trade
    JOIN public.trade_participants AS participant
      ON participant.trade_id = trade.id
     AND participant.member_id = p_member_id
     AND participant.accepted_at IS NULL
   WHERE trade.league_id = p_league_id
     AND trade.status = 'pending'::public.trade_status
     AND p_member_id IN (SELECT private.my_member_ids())
     AND p_league_id IN (SELECT private.my_league_ids());
$$;

REVOKE ALL ON FUNCTION public.get_trades_for_member(uuid, uuid, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trades_for_member(uuid, uuid, int, int) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_pending_trade_count(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pending_trade_count(uuid, uuid) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_trades_member_proposed
  ON public.trades(league_id, proposer_member_id, proposed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_trades_recipient_proposed
  ON public.trades(league_id, recipient_member_id, proposed_at DESC, id DESC);
