-- Canonical SQL source for public.propose_trade_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.propose_trade_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_recipient_member_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.create_trade_offer(
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_recipient_member_id,
    p_offer_player_ids,
    p_request_player_ids,
    p_offer_pick_ids,
    p_request_pick_ids,
    p_notes,
    p_expires_at,
    p_offer_faab_amount,
    p_request_faab_amount,
    NULL,
    NULL,
    NULL,
    1
  );
END;
$$;
