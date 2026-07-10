-- Canonical SQL source for private.prevent_league_id_rewrite.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_league_id_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid;
BEGIN
  -- Only act if league_id actually changed. BEFORE UPDATE OF
  -- league_id is a hint (fires when league_id appears in SET);
  -- the actual value may not have changed if the client did
  --   UPDATE … SET league_id = league_id
  -- so we still need the IS DISTINCT FROM guard.
  IF NEW.league_id IS DISTINCT FROM OLD.league_id THEN
    v_caller := (SELECT auth.uid());

    -- Service role / internal callers have no auth.uid().
    -- The backend bypasses RLS but triggers still fire, so we
    -- must allow this path for administrative moves. End-user
    -- PostgREST calls always have a non-null auth.uid().
    IF v_caller IS NOT NULL THEN
      RAISE EXCEPTION
        'league_members.league_id is immutable for end users.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
