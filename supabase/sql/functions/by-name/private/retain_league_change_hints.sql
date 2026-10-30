-- Canonical SQL source for private.retain_league_change_hints.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.retain_league_change_hints(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.ctid FROM public.league_change_hints r
    WHERE NOT EXISTS (SELECT 1 FROM public.leagues l WHERE l.id=r.league_id)
    ORDER BY r.league_id,r.topic LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.league_change_hints r USING victims v WHERE r.ctid=v.ctid;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.league_change_hints',v_count);
END;
$$;
