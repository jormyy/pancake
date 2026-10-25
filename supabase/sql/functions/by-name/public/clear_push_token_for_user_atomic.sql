CREATE OR REPLACE FUNCTION public.clear_push_token_for_user_atomic(
  p_user_id uuid,
  p_token text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('push-token'), hashtext(p_token));
  UPDATE profiles
     SET push_token = NULL,
         push_token_revocation_hash = NULL
   WHERE id = p_user_id
     AND push_token = p_token;
  RETURN FOUND;
END;
$$;
