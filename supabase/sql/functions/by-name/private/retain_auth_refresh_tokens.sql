CREATE OR REPLACE FUNCTION private.retain_auth_refresh_tokens(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint; v_revoked bigint;
BEGIN
  WITH expired_sessions AS MATERIALIZED (
    SELECT s.id FROM auth.sessions s
    WHERE s.not_after<p_now-interval '7 days'
      OR GREATEST(s.updated_at,s.created_at,s.refreshed_at AT TIME ZONE 'UTC')<p_now-interval '90 days'
    ORDER BY s.created_at,s.id LIMIT 500 FOR UPDATE OF s SKIP LOCKED
  ), victims AS (
    SELECT r.id FROM auth.refresh_tokens r JOIN expired_sessions s ON s.id=r.session_id
    ORDER BY r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM auth.refresh_tokens r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  WITH victims AS (
    SELECT r.id FROM auth.refresh_tokens r
    WHERE r.revoked AND r.updated_at<p_now-interval '7 days'
    ORDER BY r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM auth.refresh_tokens r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_revoked=ROW_COUNT;
  RETURN jsonb_build_object('auth.refresh_tokens',v_count+v_revoked);
END;
$$;
