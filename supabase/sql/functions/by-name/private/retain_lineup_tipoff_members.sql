CREATE OR REPLACE FUNCTION private.retain_lineup_tipoff_members(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.ctid FROM public.lineup_tipoff_members r
    WHERE r.tipoff_at<p_now-interval '30 days'
      AND EXISTS (SELECT 1 FROM public.lineup_tipoff_dispatches d WHERE d.tipoff_at=r.tipoff_at
        AND d.status IN ('succeeded','failed') AND d.finished_at<p_now-interval '30 days')
    ORDER BY r.tipoff_at,r.league_id,r.league_season_id,r.member_id,r.input_revision LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.lineup_tipoff_members r USING victims v WHERE r.ctid=v.ctid;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.lineup_tipoff_members',v_count);
END;
$$;
