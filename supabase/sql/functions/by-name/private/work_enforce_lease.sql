-- Canonical SQL source for private.work_enforce_lease.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.work_enforce_lease()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_invocation text:=nullif(nullif(current_setting('request.headers',true),'')::jsonb->>'x-pancake-work-key','');
BEGIN
  IF v_invocation IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM private.work_items WHERE invocation_key=v_invocation::uuid AND status='running' AND lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE='PT409'; END IF;
  RETURN NULL;
END;
$$;
