-- Canonical SQL source for private.enforce_stats_sync_claim_fence.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enforce_stats_sync_claim_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.job_type LIKE 'sync_stats_range:%'
     AND current_setting('app.stats_sync_fenced_transition', true) IS DISTINCT FROM 'on' THEN
    IF OLD.claim_token IS NOT NULL THEN
      RAISE EXCEPTION 'Stats sync job % is owned by a fenced claim.', OLD.id
        USING ERRCODE = '55000';
    END IF;

    IF OLD.status = 'pending'
       AND NEW.status = 'running'
       AND NEW.claim_token IS NULL THEN
      NEW.claimed_at := COALESCE(NEW.claimed_at, now());
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
