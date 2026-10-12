-- Canonical SQL source for public.clear_web_push_for_user_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.clear_web_push_for_user_atomic(
  p_user_id uuid,
  p_endpoint text,
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
     OR p_next_credential_hash IS NULL OR p_next_credential_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid Web Push cleanup.' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::bigint;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('web-push-endpoint'), hashtext(p_endpoint));
  SELECT * INTO v_control FROM private.web_push_controls WHERE endpoint = p_endpoint FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.web_push_subscriptions WHERE endpoint = p_endpoint AND user_id <> p_user_id) THEN
      RETURN QUERY SELECT false, NULL::bigint;
      RETURN;
    END IF;
    -- Even an absent delivery needs a tombstone to reject a delayed first registration.
    v_generation := 1;
    INSERT INTO private.web_push_controls(endpoint, generation, credential_hash, owner_id)
    VALUES(p_endpoint, v_generation, p_next_credential_hash, NULL);
  ELSE
    IF v_control.owner_id IS DISTINCT FROM p_user_id THEN
      RETURN QUERY SELECT false, NULL::bigint;
      RETURN;
    END IF;
    v_generation := v_control.generation + 1;
    UPDATE private.web_push_controls
       SET generation = v_generation, credential_hash = p_next_credential_hash, owner_id = NULL
     WHERE endpoint = p_endpoint;
  END IF;
  DELETE FROM public.web_push_subscriptions WHERE endpoint = p_endpoint AND user_id = p_user_id;
  RETURN QUERY SELECT true, v_generation;
END;
$$;
