CREATE OR REPLACE FUNCTION public.revoke_push_token_atomic(
  p_token text,
  p_revocation_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_token IS NULL OR p_token = '' OR octet_length(p_token) > 512 OR
     p_revocation_hash IS NULL OR p_revocation_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('push-token'), hashtext(p_token));
  UPDATE profiles
     SET push_token = NULL,
         push_token_revocation_hash = NULL
   WHERE push_token = p_token
     AND push_token_revocation_hash = p_revocation_hash;
  RETURN FOUND;
END;
$$;
