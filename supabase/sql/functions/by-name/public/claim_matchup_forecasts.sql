-- Canonical SQL source for public.claim_matchup_forecasts.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.claim_matchup_forecasts(p_limit integer DEFAULT 10)
RETURNS TABLE(matchup_id uuid, revision bigint, claim_token uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH candidates AS (
    SELECT queued.matchup_id FROM private.matchup_forecast_queue queued
    WHERE queued.dirty AND queued.available_at<=now()
      AND NOT private.matchup_forecast_refresh_pending(queued.matchup_id)
      AND (queued.claimed_at IS NULL OR queued.claimed_at<now()-interval '3 minutes')
    ORDER BY queued.changed_at,queued.matchup_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit,10),1),25)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE private.matchup_forecast_queue queued SET claim_token=gen_random_uuid(),claimed_at=now(),claimed_revision=queued.revision,
    claimed_fingerprint=COALESCE(queued.input_fingerprint,private.matchup_forecast_input_fingerprint(queued.matchup_id))
  FROM candidates WHERE queued.matchup_id=candidates.matchup_id
  RETURNING queued.matchup_id,queued.revision,queued.claim_token;
$$;
