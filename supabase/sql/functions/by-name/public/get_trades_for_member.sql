-- Canonical SQL source for public.get_trades_for_member.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  WITH authorized AS (
    SELECT EXISTS (
       SELECT 1
         FROM public.league_members AS own_member
        WHERE own_member.id = p_member_id
          AND own_member.league_id = p_league_id
          AND own_member.user_id = (SELECT auth.uid())
     ) AS allowed
  ), visible AS (
    SELECT trade AS trade_row,
      (
       trade.proposer_member_id = p_member_id
       OR trade.recipient_member_id = p_member_id
       OR EXISTS (
         SELECT 1
           FROM public.trade_participants AS participant
          WHERE participant.trade_id = trade.id
            AND participant.member_id = p_member_id
       )
      ) AS is_participant
    FROM public.trades AS trade
    CROSS JOIN authorized
    WHERE authorized.allowed
      AND trade.league_id = p_league_id
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
  ), prioritized AS (
    SELECT visible.*,
      (
        (NOT visible.is_participant AND (visible.trade_row).status = 'accepted'::public.trade_status)
        OR EXISTS (
          SELECT 1
            FROM public.trade_participants AS participant
           WHERE participant.trade_id = (visible.trade_row).id
             AND participant.member_id = p_member_id
             AND participant.accepted_at IS NULL
             AND (visible.trade_row).status = 'pending'::public.trade_status
        )
      ) AS is_actionable
      FROM visible
  )
  SELECT (prioritized.trade_row).*
    FROM prioritized
   ORDER BY prioritized.is_actionable DESC,
            prioritized.is_participant DESC,
            (prioritized.trade_row).proposed_at DESC,
            (prioritized.trade_row).id DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
$$;
