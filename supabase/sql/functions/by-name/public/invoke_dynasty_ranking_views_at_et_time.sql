-- Canonical SQL source for public.invoke_dynasty_ranking_views_at_et_time.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_dynasty_ranking_views_at_et_time(
  p_hour int,
  p_minute int DEFAULT 0,
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', p_now);
BEGIN
  -- Weekly: due on Monday from the target ET time, and on any later tick that
  -- week if Monday was missed; dispatched once per ISO week.
  IF EXTRACT(ISODOW FROM v_now)::int = 1 AND v_now::time < make_time(p_hour, p_minute, 0) THEN
    RETURN;
  END IF;
  IF NOT private.claim_cron_dispatch('et-time:sync-rankings', to_char(v_now, 'IYYY-IW')) THEN
    RETURN;
  END IF;
  PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_3"}'::jsonb);
  PERFORM public.invoke_edge_function('sync-rankings', '{"view":"ROOKIE"}'::jsonb);
  PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_5"}'::jsonb);
END;
$$;
