SET lock_timeout = '5s';
SET statement_timeout = '2min';

ALTER TABLE public.profiles
  ADD COLUMN push_token_revocation_hash text;

CREATE OR REPLACE FUNCTION private.normalize_legacy_push_token_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.push_token IS NULL THEN
    NEW.push_token_revocation_hash := NULL;
  ELSIF NEW.push_token_revocation_hash IS NULL OR (
    TG_OP = 'UPDATE'
    AND NEW.push_token IS DISTINCT FROM OLD.push_token
    AND NEW.push_token_revocation_hash IS NOT DISTINCT FROM OLD.push_token_revocation_hash
  ) THEN
    -- Old Edge versions write only push_token. Give those registrations an
    -- unexposed credential so paired state remains valid until the new RPC rotates it.
    NEW.push_token_revocation_hash := encode(extensions.gen_random_bytes(32), 'hex');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER normalize_legacy_push_token_write
  BEFORE INSERT OR UPDATE OF push_token, push_token_revocation_hash ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION private.normalize_legacy_push_token_write();

WITH ranked_tokens AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY push_token ORDER BY id) AS owner_rank
  FROM public.profiles
  WHERE push_token IS NOT NULL
)
UPDATE public.profiles AS profile
   SET push_token = NULL
  FROM ranked_tokens AS ranked
 WHERE profile.id = ranked.id
   AND ranked.owner_rank > 1;

-- Preserve existing registrations without inventing a client-visible credential.
UPDATE public.profiles
   SET push_token_revocation_hash = encode(extensions.gen_random_bytes(32), 'hex')
 WHERE push_token IS NOT NULL
   AND push_token_revocation_hash IS NULL;

CREATE UNIQUE INDEX profiles_push_token_unique
  ON public.profiles (push_token)
  WHERE push_token IS NOT NULL;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_push_token_revocation_pair CHECK (
    (push_token IS NULL) = (push_token_revocation_hash IS NULL)
  ),
  ADD CONSTRAINT profiles_push_token_revocation_hash_format CHECK (
    push_token_revocation_hash IS NULL OR push_token_revocation_hash ~ '^[0-9a-f]{64}$'
  );

REVOKE SELECT (push_token_revocation_hash) ON public.profiles FROM PUBLIC, anon, authenticated;
REVOKE UPDATE (push_token_revocation_hash) ON public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE (push_token_revocation_hash) ON public.profiles TO service_role;

CREATE OR REPLACE FUNCTION public.register_push_token_atomic(
  p_user_id uuid,
  p_token text,
  p_revocation_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
BEGIN
  IF p_token IS NULL OR p_token = '' OR octet_length(p_token) > 512 THEN
    RAISE EXCEPTION 'Invalid push token.' USING ERRCODE = '22023';
  END IF;
  IF p_revocation_hash IS NULL OR p_revocation_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid push-token revocation hash.' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('push-token'), hashtext(p_token));

  UPDATE profiles
     SET push_token = NULL,
         push_token_revocation_hash = NULL
   WHERE push_token = p_token
     AND id <> p_user_id;

  UPDATE profiles
     SET push_token = p_token,
         push_token_revocation_hash = p_revocation_hash
   WHERE id = p_user_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Profile not found.' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

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

REVOKE ALL ON FUNCTION public.register_push_token_atomic(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_push_token_atomic(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.clear_push_token_for_user_atomic(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_push_token_for_user_atomic(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.revoke_push_token_atomic(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_push_token_atomic(text, text) TO service_role;

RESET statement_timeout;
RESET lock_timeout;
