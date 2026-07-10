-- Canonical SQL source for private.fail_waiver_claim.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.fail_waiver_claim(
  p_claim_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_status waiver_claim_status,
  p_failure_reason text,
  p_event_type text DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  processed boolean,
  claim_id uuid,
  member_id uuid,
  player_id uuid,
  status waiver_claim_status,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE waiver_claims
     SET status = p_status,
         processed_at = now(),
         failure_reason = p_failure_reason
   WHERE id = p_claim_id;

  IF p_event_type IS NOT NULL THEN
    PERFORM private.log_league_activity(
      p_league_id,
      p_league_season_id,
      p_event_type,
      COALESCE(p_title, 'Waiver claim failed'),
      p_failure_reason,
      NULL,
      p_member_id,
      p_player_id,
      NULL,
      p_claim_id,
      COALESCE(p_metadata, '{}'::jsonb)
    );
  END IF;

  RETURN QUERY
    SELECT true, p_claim_id, p_member_id, p_player_id, p_status, p_failure_reason;
END;
$$;
