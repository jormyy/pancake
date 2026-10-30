-- Canonical SQL source for public.run_work_maintenance.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.run_work_maintenance(p_invocation_key uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM private.work_items WHERE invocation_key=p_invocation_key
    AND kind='league-inventory-hint-drain' AND status='running' AND lease_until>now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE='PT409'; END IF;
  RETURN private.flush_league_inventory_hints(1000);
END;
$$;
