-- Canonical SQL source for private.retain_pg_net_responses.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.retain_pg_net_responses(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM net._http_response r
    WHERE r.created<p_now-interval '6 hours'
      AND NOT EXISTS (SELECT 1 FROM public.edge_invocations i WHERE i.request_id=r.id AND i.reconciled_at IS NULL)
    ORDER BY r.created,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM net._http_response r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('net._http_response',v_count);
END;
$$;
