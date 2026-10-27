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
DECLARE
  __request_context jsonb;
  __request_result uuid;
BEGIN
  __request_context := private.request_begin('public.propose_multi_team_trade_atomic', jsonb_build_array(p_league_id, p_league_season_id, p_proposer_member_id, p_participant_member_ids, p_items, p_notes, p_expires_at), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
BEGIN
  __request_result := private.create_multi_team_trade_offer(
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_participant_member_ids,
    p_items,
    p_notes,
    p_expires_at
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;
