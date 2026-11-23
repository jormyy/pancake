-- Canonical SQL source for private.claim_cron_dispatch.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.claim_cron_dispatch(p_job text,p_every interval,p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH claimed AS (
    INSERT INTO private.cron_dispatch_claims AS claim(job,period_start,claimed_at)
    VALUES(p_job,date_bin(p_every,p_now,timestamptz '2000-01-03 00:00+00'),clock_timestamp())
    ON CONFLICT(job) DO UPDATE SET period_start=excluded.period_start,claimed_at=excluded.claimed_at
    WHERE claim.period_start IS DISTINCT FROM excluded.period_start
    RETURNING 1
  )
  SELECT EXISTS(SELECT 1 FROM claimed);
$$;
