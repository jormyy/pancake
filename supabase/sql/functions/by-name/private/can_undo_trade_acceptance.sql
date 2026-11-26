-- Canonical SQL source for private.can_undo_trade_acceptance.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.can_undo_trade_acceptance(
  p_trade_id uuid,
  p_member_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM trades trade
     WHERE trade.id = p_trade_id
       AND trade.status = 'pending'::trade_status
       AND (SELECT count(*) FROM trade_participants participant WHERE participant.trade_id = trade.id) >= 3
       AND EXISTS (
         SELECT 1 FROM trade_participants participant
          WHERE participant.trade_id = trade.id
            AND participant.member_id = p_member_id
            AND participant.accepted_at IS NOT NULL)
       AND EXISTS (
         SELECT 1 FROM trade_participants participant
          WHERE participant.trade_id = trade.id
            AND participant.member_id <> p_member_id
            AND participant.accepted_at IS NULL)
  );
$$;
