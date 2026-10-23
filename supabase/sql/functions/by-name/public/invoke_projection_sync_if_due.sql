-- Canonical SQL source for public.invoke_projection_sync_if_due.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_projection_sync_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_work record;
BEGIN
  FOR v_work IN SELECT * FROM private.projection_sync_due_work() LOOP
    IF private.claim_cron_dispatch(v_work.job_key,v_work.period_key) THEN
      PERFORM private.invoke_claimed_edge_function(v_work.job_key,v_work.function_name);
    END IF;
  END LOOP;
END;
$$;
