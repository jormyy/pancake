-- Canonical SQL source for private.prevent_self_role_escalation.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_self_role_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid;
BEGIN
  -- Only act if role actually changed (BEFORE UPDATE OF role is a hint;
  -- this guard is the authoritative check).
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    v_caller := (SELECT auth.uid());

    -- Service role / internal callers have no auth.uid() — trust them.
    -- All end-user calls via PostgREST have a non-null auth.uid().
    IF v_caller IS NOT NULL THEN
      IF NOT private.is_commissioner(NEW.league_id) THEN
        RAISE EXCEPTION
          'Only commissioners can change league member roles.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
