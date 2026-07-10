-- Canonical SQL source for public.get_pending_trade_count.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
     AND EXISTS (
       SELECT 1
         FROM public.league_members AS own_member
        WHERE own_member.id = p_member_id
          AND own_member.league_id = p_league_id
          AND own_member.user_id = (SELECT auth.uid())
     );
$$;
