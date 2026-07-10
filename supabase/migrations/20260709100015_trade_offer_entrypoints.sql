-- Backfill routes only after migration 14 has made the legacy producer compatible,
-- then switch the acceptance return contract atomically in this transaction.

SET lock_timeout = '5s';
SET statement_timeout = '2min';

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
DROP FUNCTION IF EXISTS public.accept_multi_team_trade_atomic(uuid, uuid, uuid[]);

CREATE OR REPLACE FUNCTION public.accept_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid,
  p_drop_roster_player_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.accept_trade_participant_atomic(
    p_trade_id,
    p_accepting_member_id,
    p_drop_roster_player_ids
  );
END;
$$;

REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_atomic(uuid, uuid, uuid[]) TO service_role;

RESET statement_timeout;
RESET lock_timeout;
