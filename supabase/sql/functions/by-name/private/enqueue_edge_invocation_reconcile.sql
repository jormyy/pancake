-- Canonical SQL source for private.enqueue_edge_invocation_reconcile.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_edge_invocation_reconcile(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE reconciled_at IS NULL OR worker_status='running') THEN RETURN; END IF;
  IF private.claim_cron_dispatch('edge-invocation-reconcile',interval '5 minutes',p_now) THEN
    PERFORM private.work_enqueue('edge-invocation-reconcile',date_bin(interval '5 minutes',p_now,timestamptz '2000-01-03 00:00+00')::text,p_now);
  END IF;
END;
$$;
