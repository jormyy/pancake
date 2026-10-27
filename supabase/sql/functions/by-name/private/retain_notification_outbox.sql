CREATE OR REPLACE FUNCTION private.retain_notification_outbox(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM public.notification_outbox r
    WHERE COALESCE(r.delivered_at,r.dead_lettered_at,r.suppressed_at)<p_now-interval '60 days'
    ORDER BY COALESCE(r.delivered_at,r.dead_lettered_at,r.suppressed_at),r.id LIMIT 20000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.notification_outbox r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.notification_outbox',v_count);
END;
$$;
