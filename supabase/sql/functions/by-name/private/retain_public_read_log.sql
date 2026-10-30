-- Canonical SQL source for private.retain_public_read_log.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.retain_public_read_log(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE removed integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(9182,17) THEN RETURN jsonb_build_object('public.public_read_log',0); END IF;
  WITH expired AS (
    SELECT league_id,hour,resource FROM public.public_read_log
    WHERE hour<date_trunc('hour',p_now)-interval '7 days'
    ORDER BY hour,league_id,resource LIMIT 5000 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.public_read_log row USING expired
    WHERE row.league_id=expired.league_id AND row.hour=expired.hour AND row.resource=expired.resource;
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN jsonb_build_object('public.public_read_log',removed);
END;
$$;
