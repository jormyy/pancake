-- Canonical SQL source for private.retain_sleeper_projection_rows.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.retain_sleeper_projection_rows(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint; v_previous text:=COALESCE(current_setting('pancake.projection_cleanup',true),'');
BEGIN
  PERFORM set_config('pancake.projection_cleanup','on',true);
  WITH victims AS (
    SELECT r.id FROM public.sleeper_projection_rows r
    WHERE r.game_date<date_trunc('week',timezone('America/Los_Angeles',p_now))::date
    ORDER BY r.game_date,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.sleeper_projection_rows r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  PERFORM set_config('pancake.projection_cleanup',v_previous,true);
  RETURN jsonb_build_object('public.sleeper_projection_rows',v_count);
END;
$$;
