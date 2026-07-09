-- Canonical SQL source for private.log_league_activity.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.log_league_activity(
  p_league_id uuid,
  p_league_season_id uuid,
  p_event_type text,
  p_title text,
  p_body text DEFAULT NULL,
  p_actor_member_id uuid DEFAULT NULL,
  p_target_member_id uuid DEFAULT NULL,
  p_related_player_id uuid DEFAULT NULL,
  p_related_trade_id uuid DEFAULT NULL,
  p_related_claim_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_player_id,
    related_trade_id,
    related_claim_id,
    event_type,
    title,
    body,
    metadata
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_actor_member_id,
    p_target_member_id,
    p_related_player_id,
    p_related_trade_id,
    p_related_claim_id,
    p_event_type,
    p_title,
    p_body,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
