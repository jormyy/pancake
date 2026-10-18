-- Canonical SQL source for private.enforce_live_poll_lease.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enforce_live_poll_lease()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_holder text := NULLIF(COALESCE(NULLIF(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb)->>'x-pancake-live-holder','');
BEGIN
  IF v_holder IS NOT NULL THEN PERFORM private.lock_live_poll_holder(v_holder::uuid); END IF;
  RETURN NULL;
END;
$$;
