-- Canonical SQL source for private.is_trade_party.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.is_trade_party(p_trade_id uuid)
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
         trade.proposer_member_id IN (SELECT private.my_member_ids())
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
