-- Canonical SQL source for public.register_web_push_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.register_web_push_atomic(
  p_user_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_expected_generation bigint,
  p_credential_hash text,
  p_next_credential_hash text
)
RETURNS TABLE (applied boolean, generation bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_control private.web_push_controls%ROWTYPE;
  v_generation bigint;
BEGIN
  IF p_endpoint IS NULL OR p_endpoint !~ '^https://' OR octet_length(p_endpoint) > 2048
     OR p_p256dh IS NULL OR p_p256dh !~ '^[A-Za-z0-9_-]{87}$'
     OR p_auth IS NULL OR p_auth !~ '^[A-Za-z0-9_-]{22}$'
     OR p_expected_generation IS NULL OR p_expected_generation < 0 OR p_expected_generation >= 9007199254740991
     OR p_credential_hash IS NULL OR p_credential_hash !~ '^[0-9a-f]{64}$'
     OR p_next_credential_hash IS NULL OR p_next_credential_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid Web Push registration.' USING ERRCODE = '22023';
  END IF;

  -- Profile deletion takes this lock before invalidating endpoint authority.
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found.' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('web-push-endpoint'), hashtext(p_endpoint));
  SELECT * INTO v_control FROM private.web_push_controls WHERE endpoint = p_endpoint FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_generation <> 0 OR EXISTS (
      SELECT 1 FROM public.web_push_subscriptions WHERE endpoint = p_endpoint AND user_id <> p_user_id
    ) THEN
      RETURN QUERY SELECT false, NULL::bigint;
      RETURN;
    END IF;
    v_generation := 1;
    INSERT INTO private.web_push_controls(endpoint, generation, credential_hash, owner_id)
    VALUES(p_endpoint, v_generation, p_next_credential_hash, p_user_id);
  ELSE
    IF v_control.generation <> p_expected_generation
       OR v_control.credential_hash IS DISTINCT FROM p_credential_hash THEN
      RETURN QUERY SELECT false, NULL::bigint;
      RETURN;
    END IF;
    v_generation := v_control.generation + 1;
    UPDATE private.web_push_controls
       SET generation = v_generation, credential_hash = p_next_credential_hash, owner_id = p_user_id
     WHERE endpoint = p_endpoint;
  END IF;
  INSERT INTO public.web_push_subscriptions(user_id, endpoint, p256dh, auth, updated_at)
  VALUES(p_user_id, p_endpoint, p_p256dh, p_auth, clock_timestamp())
  ON CONFLICT (endpoint) DO UPDATE
    SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, updated_at = EXCLUDED.updated_at;
  RETURN QUERY SELECT true, v_generation;
END;
$$;
