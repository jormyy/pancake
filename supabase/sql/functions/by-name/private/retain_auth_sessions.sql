CREATE OR REPLACE FUNCTION private.retain_auth_sessions(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT s.id FROM auth.sessions s
    WHERE (s.not_after<p_now-interval '7 days'
      OR GREATEST(s.updated_at,s.created_at,s.refreshed_at AT TIME ZONE 'UTC')<p_now-interval '90 days')
      AND NOT EXISTS(SELECT 1 FROM auth.refresh_tokens r WHERE r.session_id=s.id)
    ORDER BY s.created_at,s.id LIMIT 500 FOR UPDATE OF s SKIP LOCKED
  ) DELETE FROM auth.sessions s USING victims v WHERE s.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('auth.sessions',v_count);
END;
$$;
