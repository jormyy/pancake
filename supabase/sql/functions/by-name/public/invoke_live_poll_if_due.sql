-- Canonical SQL source for public.invoke_live_poll_if_due.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_live_poll_if_due()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.live_poll_leases WHERE lock_key=779001 AND expires_at>clock_timestamp()) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.get_live_poll_work()) THEN
    PERFORM public.invoke_edge_function('live-poll');
  END IF;
END;
$$;
