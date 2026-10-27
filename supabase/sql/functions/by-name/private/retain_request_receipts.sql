CREATE OR REPLACE FUNCTION private.retain_request_receipts(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.request_id FROM private.request_receipts r WHERE r.created_at<p_now-interval '7 days'
    ORDER BY r.created_at,r.request_id LIMIT 20000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM private.request_receipts r USING victims v WHERE r.request_id=v.request_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('private.request_receipts',v_count);
END;
$$;
