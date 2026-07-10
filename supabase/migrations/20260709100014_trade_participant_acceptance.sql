-- Canonicalize all trade acceptance and settlement on routed participants/items.

INSERT INTO public.trade_participants (trade_id, member_id, sort_order, is_initiator, accepted_at)
SELECT trade.id, trade.proposer_member_id, 0, true, trade.proposed_at
  FROM public.trades AS trade
 WHERE NOT EXISTS (
   SELECT 1 FROM public.trade_participants AS participant
    WHERE participant.trade_id = trade.id AND participant.member_id = trade.proposer_member_id
 )
ON CONFLICT (trade_id, member_id) DO NOTHING;

INSERT INTO public.trade_participants (trade_id, member_id, sort_order, is_initiator, accepted_at)
SELECT
  trade.id,
  trade.recipient_member_id,
  1,
  false,
  CASE
    WHEN trade.status IN ('accepted'::public.trade_status, 'completed'::public.trade_status, 'vetoed'::public.trade_status)
      THEN trade.accepted_at
    ELSE NULL
  END
  FROM public.trades AS trade
 WHERE NOT EXISTS (
   SELECT 1 FROM public.trade_participants AS participant
    WHERE participant.trade_id = trade.id AND participant.member_id = trade.recipient_member_id
 )
ON CONFLICT (trade_id, member_id) DO NOTHING;

INSERT INTO public.trade_items (trade_id, side, from_member_id, to_member_id, faab_amount)
SELECT trade.id, 'proposer'::public.trade_side, trade.proposer_member_id, trade.recipient_member_id, trade.proposer_faab_amount
  FROM public.trades AS trade
 WHERE COALESCE(trade.is_multi_team, false) = false
   AND trade.status IN ('pending'::public.trade_status, 'accepted'::public.trade_status)
   AND trade.proposer_faab_amount > 0
   AND NOT EXISTS (
     SELECT 1 FROM public.trade_items AS item
      WHERE item.trade_id = trade.id AND item.from_member_id = trade.proposer_member_id
        AND item.to_member_id = trade.recipient_member_id AND item.faab_amount > 0
   );

INSERT INTO public.trade_items (trade_id, side, from_member_id, to_member_id, faab_amount)
SELECT trade.id, 'recipient'::public.trade_side, trade.recipient_member_id, trade.proposer_member_id, trade.recipient_faab_amount
  FROM public.trades AS trade
 WHERE COALESCE(trade.is_multi_team, false) = false
   AND trade.status IN ('pending'::public.trade_status, 'accepted'::public.trade_status)
   AND trade.recipient_faab_amount > 0
   AND NOT EXISTS (
     SELECT 1 FROM public.trade_items AS item
      WHERE item.trade_id = trade.id AND item.from_member_id = trade.recipient_member_id
        AND item.to_member_id = trade.proposer_member_id AND item.faab_amount > 0
   );

DROP FUNCTION IF EXISTS public.accept_trade_atomic(uuid, uuid, uuid[]);
