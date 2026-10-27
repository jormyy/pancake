CREATE OR REPLACE FUNCTION private.retain_lineup_tipoff_dispatches(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.tipoff_at FROM public.lineup_tipoff_dispatches r
    WHERE r.status IN ('succeeded','failed') AND r.finished_at<p_now-interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM public.lineup_tipoff_members m WHERE m.tipoff_at=r.tipoff_at)
    ORDER BY r.tipoff_at LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.lineup_tipoff_dispatches r USING victims v WHERE r.tipoff_at=v.tipoff_at;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.lineup_tipoff_dispatches',v_count);
END;
$$;
