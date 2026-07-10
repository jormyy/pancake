-- Canonical SQL source for public.propose_multi_team_trade_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.propose_multi_team_trade_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.create_multi_team_trade_offer(
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_participant_member_ids,
    p_items,
    p_notes,
    p_expires_at
  );
END;
$$;
