-- Canonical SQL source for private.normalize_legacy_push_token_write.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.normalize_legacy_push_token_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.push_token IS NULL THEN
    NEW.push_token_revocation_hash := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.push_token IS DISTINCT FROM OLD.push_token THEN
    PERFORM pg_advisory_xact_lock(hashtext('push-token'), hashtext(NEW.push_token));
    UPDATE public.profiles
       SET push_token = NULL,
           push_token_revocation_hash = NULL
     WHERE push_token = NEW.push_token
       AND id <> NEW.id;
  END IF;

  IF NEW.push_token_revocation_hash IS NULL OR (
    TG_OP = 'UPDATE'
    AND NEW.push_token IS DISTINCT FROM OLD.push_token
    AND NEW.push_token_revocation_hash IS NOT DISTINCT FROM OLD.push_token_revocation_hash
  ) THEN
    -- Old Edge versions write only push_token. Give those registrations an
    -- unexposed credential so paired state remains valid until the new RPC rotates it.
    NEW.push_token_revocation_hash := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  END IF;
  RETURN NEW;
END;
$$;
