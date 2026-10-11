-- Canonical SQL source for private.revoke_deleted_profile_web_push.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.revoke_deleted_profile_web_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE private.web_push_controls
     SET owner_id = NULL, credential_hash = NULL, generation = generation + 1
   WHERE owner_id = OLD.id;
  RETURN OLD;
END;
$$;
